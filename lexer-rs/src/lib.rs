//! Finds the imports in a JavaScript module: a drop-in replacement for es-module-lexer's
//! `parse()`, compiled to WebAssembly and called from Node (see src/lexer/rust.ts).
//!
//! For every import it reports the same numbers es-module-lexer does:
//!
//!   s, e  where the specifier is in the source
//!           static:   import x from './a.js'    -> s..e covers  ./a.js        (no quotes)
//!           dynamic:  import('./a.js')          -> s..e covers  './a.js'      (with quotes)
//!           meta:     import.meta               -> s..e covers  import.meta
//!   d     -1 static import, -2 import.meta, otherwise the offset of the `(` of import()
//!
//! The source arrives as UTF-16 code units (`&[u16]`), not UTF-8 bytes. JS strings are UTF-16,
//! and `s`/`e` must be JS string indexes, so lexing UTF-16 means no offset conversion.
//!
//! "Lexer" is the key word: it doesn't build a syntax tree. It walks the characters once,
//! skipping strings, comments, template literals and regexes (so `"import x from 'y'"`
//! inside a string isn't an import), and looks closer only around the words `import`
//! and `export`.

// ---------------------------------------------------------------------------
// The interface Node sees (the .wasm exports)
// ---------------------------------------------------------------------------
//
// Calling convention, all numbers:
//   1. ptr = input_buffer(len)  Rust sizes its input buffer and returns its address
//   2. JS writes the string's UTF-16 code units into wasm memory at ptr
//   3. n = parse(len)           n >= 0: number of imports found
//                               n <  0: parse error at offset (-n - 1)
//   4. JS reads n * 4 i32s at output_ptr(): [s, e, d, is_literal] per import
//
// Wasm modules here are single-threaded and Node calls them synchronously, so plain
// statics are fine. `&raw mut` avoids creating references to a `static mut` directly.

struct Buffers {
    input: Vec<u16>,
    output: Vec<i32>,
}

static mut BUFFERS: Buffers = Buffers { input: Vec::new(), output: Vec::new() };

fn buffers() -> &'static mut Buffers {
    unsafe { &mut *(&raw mut BUFFERS) }
}

#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(len: usize) -> *mut u16 {
    let input = &mut buffers().input;
    input.clear();
    input.resize(len, 0); // may grow wasm memory; JS must re-create its views after this call
    input.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn parse(len: usize) -> i32 {
    let Buffers { input, output } = buffers();
    let mut lexer = Lexer::new(&input[..len]);
    output.clear();
    match lexer.run() {
        Ok(()) => {
            for imp in &lexer.imports {
                output.extend_from_slice(&[imp.s as i32, imp.e as i32, imp.d, imp.literal as i32]);
            }
            lexer.imports.len() as i32
        }
        Err(offset) => -(offset as i32) - 1,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const i32 {
    buffers().output.as_ptr()
}

// ---------------------------------------------------------------------------
// The lexer
// ---------------------------------------------------------------------------

const NUL: u16 = 0; // what `at()` returns past the end
const TAB: u16 = 0x09;
const NL: u16 = b'\n' as u16;
const CR: u16 = b'\r' as u16;
const BANG: u16 = b'!' as u16;
const QUOTE_D: u16 = b'"' as u16;
const HASH: u16 = b'#' as u16;
const DOLLAR: u16 = b'$' as u16;
const QUOTE_S: u16 = b'\'' as u16;
const LPAREN: u16 = b'(' as u16;
const RPAREN: u16 = b')' as u16;
const STAR: u16 = b'*' as u16;
const COMMA: u16 = b',' as u16;
const DOT: u16 = b'.' as u16;
const SLASH: u16 = b'/' as u16;
const LBRACK: u16 = b'[' as u16;
const BACKSLASH: u16 = b'\\' as u16;
const RBRACK: u16 = b']' as u16;
const BACKTICK: u16 = b'`' as u16;
const LBRACE: u16 = b'{' as u16;
const RBRACE: u16 = b'}' as u16;

struct Import {
    s: u32,
    e: u32,
    d: i32,
    /// The specifier is a plain string literal, so JS can read its value from s..e.
    literal: bool,
}

/// Open brackets we're inside of. Needed to know what a `}` closes: a block, or the
/// `${ ... }` of a template literal (after which we're back inside the template string).
enum Frame {
    Brace,
    Paren,
    TemplateExpr,
    /// The `(` of `import(...)`, with the index of its Import, to fill in `e` on `)`.
    DynamicImport(usize),
}

/// Err carries the offset where lexing failed (unterminated string, unbalanced brace...).
type LexResult<T> = Result<T, usize>;

struct Lexer<'a> {
    src: &'a [u16],
    pos: usize,
    imports: Vec<Import>,
    stack: Vec<Frame>,
    /// The classic JS lexing ambiguity: is `/` division (`a / b`) or a regex (`= /ab+c/`)?
    /// It depends on the previous token: after a value it's division, otherwise a regex.
    regex_allowed: bool,
    /// The previous token was a member-access `.`, so the next word is a property name
    /// (`obj.import(...)` is a method call, not a dynamic import). Comments and whitespace
    /// don't reset it, which is the point: we must not look *backwards* across them.
    after_dot: bool,
}

impl<'a> Lexer<'a> {
    fn new(src: &'a [u16]) -> Self {
        Lexer { src, pos: 0, imports: Vec::new(), stack: Vec::new(), regex_allowed: true, after_dot: false }
    }

    fn at(&self, i: usize) -> u16 {
        if i < self.src.len() { self.src[i] } else { NUL }
    }

    fn run(&mut self) -> LexResult<()> {
        let len = self.src.len();
        if self.at(0) == HASH && self.at(1) == BANG {
            self.pos = self.line_end(0); // #!/usr/bin/env node
        }

        while self.pos < len {
            let c = self.src[self.pos];
            if is_whitespace(c) {
                self.pos += 1;
                continue;
            }
            if c == SLASH && matches!(self.at(self.pos + 1), SLASH | STAR) {
                self.pos = self.skip_trivia(self.pos)?; // comments are invisible: keep after_dot as is
                continue;
            }
            // `.` but not the last dot of a `...` spread
            let is_member_dot = c == DOT && !is_digit(self.at(self.pos + 1)) && !(self.pos > 0 && self.src[self.pos - 1] == DOT);
            let after_dot = std::mem::replace(&mut self.after_dot, is_member_dot);
            match c {
                SLASH => {
                    if self.regex_allowed {
                        self.pos = self.regex_end(self.pos)?;
                        self.regex_allowed = false;
                    } else {
                        self.pos += 1;
                        self.regex_allowed = true;
                    }
                }
                QUOTE_S | QUOTE_D => {
                    self.pos = self.string_end(self.pos)?;
                    self.regex_allowed = false;
                }
                BACKTICK => {
                    self.pos += 1;
                    self.template()?;
                }
                LBRACE => {
                    self.stack.push(Frame::Brace);
                    self.pos += 1;
                    self.regex_allowed = true;
                }
                RBRACE => match self.stack.pop() {
                    Some(Frame::Brace) => {
                        self.pos += 1;
                        self.regex_allowed = true;
                    }
                    Some(Frame::TemplateExpr) => {
                        self.pos += 1;
                        self.template()?; // `}` of `${...}`: continue scanning the template string
                    }
                    _ => return Err(self.pos),
                },
                LPAREN => {
                    self.stack.push(Frame::Paren);
                    self.pos += 1;
                    self.regex_allowed = true;
                }
                RPAREN => {
                    match self.stack.pop() {
                        Some(Frame::Paren) => {}
                        Some(Frame::DynamicImport(i)) => {
                            // `import(someExpression)`: the specifier is everything up to here.
                            if !self.imports[i].literal {
                                self.imports[i].e = self.trim_end(self.pos) as u32;
                            }
                        }
                        _ => return Err(self.pos),
                    }
                    self.pos += 1;
                    self.regex_allowed = false;
                }
                RBRACK => {
                    self.pos += 1;
                    self.regex_allowed = false;
                }
                _ if is_ident_start(c) => self.identifier(after_dot)?,
                _ if is_digit(c) || (c == DOT && is_digit(self.at(self.pos + 1))) => {
                    self.pos = self.number_end(self.pos);
                    self.regex_allowed = false;
                }
                _ => {
                    // any other punctuator: = + - ! ? : ; , < > & | ^ ~ % [ .
                    self.pos += 1;
                    self.regex_allowed = true;
                }
            }
        }

        if self.stack.is_empty() { Ok(()) } else { Err(len) }
    }

    fn identifier(&mut self, member: bool) -> LexResult<()> {
        let start = self.pos;
        let end = self.ident_end(start);
        self.pos = end;

        // `obj.import(...)` or `obj.export` are property accesses, not module syntax.
        if !member {
            if self.word_eq(start, end, "import") {
                return self.import(start);
            }
            if self.word_eq(start, end, "export") {
                return self.export();
            }
        }
        self.regex_allowed = !member && is_expression_keyword(&self.src[start..end]);
        Ok(())
    }

    /// We just read the word `import` starting at `start`. Which kind is it?
    fn import(&mut self, start: usize) -> LexResult<()> {
        let p = self.skip_trivia(self.pos)?;
        let c = self.at(p);

        // import.meta
        if c == DOT {
            let q = self.skip_trivia(p + 1)?;
            let q_end = self.ident_end(q);
            if self.word_eq(q, q_end, "meta") {
                self.imports.push(Import { s: start as u32, e: q_end as u32, d: -2, literal: false });
                self.pos = q_end;
                self.regex_allowed = false;
            }
            return Ok(());
        }

        // import('./x.js')  or  import(someVariable)
        if c == LPAREN {
            let index = self.imports.len();
            self.imports.push(Import { s: 0, e: 0, d: p as i32, literal: false });
            self.stack.push(Frame::DynamicImport(index));

            let q = self.skip_trivia(p + 1)?;
            self.imports[index].s = q as u32;
            if is_quote(self.at(q)) {
                let end = self.string_end(q)?;
                let after = self.at(self.skip_trivia(end)?);
                // Only a *whole* string argument counts. `import('./' + name)` doesn't.
                if after == RPAREN || after == COMMA {
                    self.imports[index].e = end as u32;
                    self.imports[index].literal = true;
                    self.pos = end;
                    self.regex_allowed = false;
                    return Ok(());
                }
            }
            // Not a literal: keep lexing the argument normally; `)` will close it.
            self.pos = p + 1;
            self.regex_allowed = true;
            return Ok(());
        }

        // import './side-effect.js'
        if is_quote(c) {
            let end = self.string_end(p)?;
            self.push_static(p, end);
            return Ok(());
        }

        // import x, { y as z } from './x.js'   /   import * as ns from './x.js'
        if c == LBRACE || c == STAR || is_ident_start(c) {
            let mut q = p;
            loop {
                q = self.skip_trivia(q)?;
                let qc = self.at(q);
                if qc == LBRACE {
                    q = self.braces_end(q)?;
                } else if qc == STAR || qc == COMMA {
                    q += 1;
                } else if is_ident_start(qc) {
                    let q_end = self.ident_end(q);
                    let is_from = self.word_eq(q, q_end, "from");
                    q = q_end;
                    if is_from {
                        let r = self.skip_trivia(q)?;
                        if is_quote(self.at(r)) {
                            let end = self.string_end(r)?;
                            self.push_static(r, end);
                            return Ok(());
                        }
                        // `import from from './x'` (a default import named "from"): keep going
                    }
                } else {
                    return Err(q);
                }
            }
        }

        self.regex_allowed = false;
        Ok(())
    }

    /// We just read the word `export`. Only `export ... from '...'` forms import anything.
    fn export(&mut self) -> LexResult<()> {
        let p = self.skip_trivia(self.pos)?;
        let c = self.at(p);
        self.regex_allowed = true;
        if c != STAR && c != LBRACE {
            return Ok(()); // export const / function / default ...: lex the rest normally
        }

        let mut q = self.skip_trivia(if c == STAR { p + 1 } else { self.braces_end(p)? })?;
        if c == STAR {
            // export * as ns from './x.js'
            let q_end = self.ident_end(q);
            if self.word_eq(q, q_end, "as") {
                q = self.skip_trivia(q_end)?;
                q = if is_quote(self.at(q)) { self.string_end(q)? } else { self.ident_end(q) };
                q = self.skip_trivia(q)?;
            }
        }
        let q_end = self.ident_end(q);
        if self.word_eq(q, q_end, "from") {
            let r = self.skip_trivia(q_end)?;
            if is_quote(self.at(r)) {
                let end = self.string_end(r)?;
                self.push_static(r, end);
                return Ok(());
            }
        }
        self.pos = q; // `export { a, b }` with no `from`
        Ok(())
    }

    /// Record a static import whose string literal spans quote_start..end (quotes included).
    fn push_static(&mut self, quote_start: usize, end: usize) {
        self.imports.push(Import { s: quote_start as u32 + 1, e: end as u32 - 1, d: -1, literal: true });
        self.pos = end;
        self.regex_allowed = true;
    }

    // --- skipping things -------------------------------------------------------

    /// Index just past the closing quote of the string starting at `start`.
    fn string_end(&self, start: usize) -> LexResult<usize> {
        let quote = self.src[start];
        let mut i = start + 1;
        while i < self.src.len() {
            let c = self.src[i];
            if c == quote {
                return Ok(i + 1);
            }
            if c == BACKSLASH {
                i += if self.at(i + 1) == CR && self.at(i + 2) == NL { 3 } else { 2 };
                continue;
            }
            if c == NL || c == CR {
                return Err(i); // unterminated string
            }
            i += 1;
        }
        Err(start)
    }

    /// Scan template literal text from `self.pos` until the closing backtick or a `${`.
    fn template(&mut self) -> LexResult<()> {
        let mut i = self.pos;
        while i < self.src.len() {
            let c = self.src[i];
            if c == BACKTICK {
                self.pos = i + 1;
                self.regex_allowed = false;
                return Ok(());
            }
            if c == BACKSLASH {
                i += 2;
                continue;
            }
            if c == DOLLAR && self.at(i + 1) == LBRACE {
                self.stack.push(Frame::TemplateExpr);
                self.pos = i + 2;
                self.regex_allowed = true;
                return Ok(());
            }
            i += 1;
        }
        Err(self.pos)
    }

    /// Index just past a regex literal starting at `start` (including its flags).
    fn regex_end(&self, start: usize) -> LexResult<usize> {
        let mut i = start + 1;
        let mut in_class = false; // inside [...], where `/` doesn't end the regex
        loop {
            match self.at(i) {
                BACKSLASH => i += 2,
                LBRACK => {
                    in_class = true;
                    i += 1;
                }
                RBRACK => {
                    in_class = false;
                    i += 1;
                }
                SLASH if !in_class => return Ok(self.ident_end(i + 1)),
                NL | CR => return Err(start),
                NUL if i >= self.src.len() => return Err(start),
                _ => i += 1,
            }
        }
    }

    /// Index just past a `{ ... }` group (used for import/export binding lists).
    fn braces_end(&self, start: usize) -> LexResult<usize> {
        let mut i = start + 1;
        loop {
            i = self.skip_trivia(i)?;
            match self.at(i) {
                RBRACE => return Ok(i + 1),
                QUOTE_S | QUOTE_D => i = self.string_end(i)?, // import { "a-b" as c }
                NUL if i >= self.src.len() => return Err(start),
                _ => i += 1,
            }
        }
    }

    fn line_end(&self, mut i: usize) -> usize {
        while i < self.src.len() && self.src[i] != NL && self.src[i] != CR {
            i += 1;
        }
        i
    }

    fn block_comment_end(&self, start: usize) -> LexResult<usize> {
        let mut i = start + 2;
        while i + 1 < self.src.len() {
            if self.src[i] == STAR && self.src[i + 1] == SLASH {
                return Ok(i + 2);
            }
            i += 1;
        }
        Err(start)
    }

    /// Skip whitespace and comments.
    fn skip_trivia(&self, mut i: usize) -> LexResult<usize> {
        loop {
            let c = self.at(i);
            if is_whitespace(c) {
                i += 1;
            } else if c == SLASH && self.at(i + 1) == SLASH {
                i = self.line_end(i);
            } else if c == SLASH && self.at(i + 1) == STAR {
                i = self.block_comment_end(i)?;
            } else {
                return Ok(i);
            }
        }
    }

    fn ident_end(&self, mut i: usize) -> usize {
        while i < self.src.len() && (is_ident_start(self.src[i]) || is_digit(self.src[i])) {
            i += 1;
        }
        i
    }

    /// Numbers are read loosely (1, 1.5, 0xff, 1e3, 10n): we only need to skip them.
    fn number_end(&self, mut i: usize) -> usize {
        while i < self.src.len() && (is_ident_start(self.src[i]) || is_digit(self.src[i]) || self.src[i] == DOT) {
            i += 1;
        }
        i
    }

    /// End of the last non-whitespace character before `i`.
    fn trim_end(&self, mut i: usize) -> usize {
        while i > 0 && is_whitespace(self.src[i - 1]) {
            i -= 1;
        }
        i
    }

    fn word_eq(&self, start: usize, end: usize, word: &str) -> bool {
        end - start == word.len() && word.bytes().zip(&self.src[start..end]).all(|(a, &b)| a as u16 == b)
    }
}

fn is_quote(c: u16) -> bool {
    c == QUOTE_S || c == QUOTE_D
}

fn is_digit(c: u16) -> bool {
    c.wrapping_sub(b'0' as u16) < 10
}

fn is_whitespace(c: u16) -> bool {
    matches!(c, TAB | NL | 0x0B | 0x0C | CR | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

fn is_ident_start(c: u16) -> bool {
    (c | 0x20).wrapping_sub(b'a' as u16) < 26 || c == b'_' as u16 || c == DOLLAR || (c >= 0x80 && !is_whitespace(c))
}

/// Keywords after which an expression starts, so a following `/` begins a regex:
/// `return /x/.test(s)` vs `count / 2`.
fn is_expression_keyword(word: &[u16]) -> bool {
    const KEYWORDS: [&str; 15] = [
        "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do",
        "else", "yield", "await", "default",
    ];
    KEYWORDS.iter().any(|k| k.len() == word.len() && k.bytes().zip(word).all(|(a, &b)| a as u16 == b))
}
