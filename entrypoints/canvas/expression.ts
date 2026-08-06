/**
 * MV3 CSP 安全的流程表达式求值器。
 *
 * 支持：字面量、括号、vars.foo / vars['foo'] / vars.get('foo') / get('foo')、
 * !、四则运算、比较运算以及 && / ||。不执行任意 JavaScript。
 */

type TokenKind = 'number' | 'string' | 'identifier' | 'operator' | 'punctuation' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  offset: number;
}

export function evaluateExpression(source: string, variables: Record<string, unknown>): unknown {
  const parser = new ExpressionParser(tokenize(source), variables);
  const value = parser.parse();
  return value;
}

class ExpressionParser {
  private index = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  parse(): unknown {
    const value = this.parseOr();
    const remaining = this.peek();
    if (remaining.kind !== 'eof') this.fail(`无法识别的内容“${remaining.value}”`, remaining);
    return value;
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.matchOperator('||')) {
      const right = this.parseAnd();
      left = Boolean(left) ? left : right;
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseEquality();
    while (this.matchOperator('&&')) {
      const right = this.parseEquality();
      left = Boolean(left) ? right : left;
    }
    return left;
  }

  private parseEquality(): unknown {
    let left = this.parseComparison();
    while (this.peekIsOperator('===', '!==', '==', '!=')) {
      const operator = this.consume().value;
      const right = this.parseComparison();
      const equal = operator.length === 3 ? left === right : looselyEqual(left, right);
      left = operator === '!==' || operator === '!=' ? !equal : equal;
    }
    return left;
  }

  private parseComparison(): unknown {
    let left = this.parseAdditive();
    while (this.peekIsOperator('<', '<=', '>', '>=')) {
      const operator = this.consume().value;
      const right = this.parseAdditive();
      const comparison = compare(left, right);
      if (operator === '<') left = comparison < 0;
      else if (operator === '<=') left = comparison <= 0;
      else if (operator === '>') left = comparison > 0;
      else left = comparison >= 0;
    }
    return left;
  }

  private parseAdditive(): unknown {
    let left = this.parseMultiplicative();
    while (this.peekIsOperator('+', '-')) {
      const operator = this.consume().value;
      const right = this.parseMultiplicative();
      if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) {
        left = String(left ?? '') + String(right ?? '');
      } else {
        left = operator === '+' ? toNumber(left) + toNumber(right) : toNumber(left) - toNumber(right);
      }
    }
    return left;
  }

  private parseMultiplicative(): unknown {
    let left = this.parseUnary();
    while (this.peekIsOperator('*', '/', '%')) {
      const operator = this.consume().value;
      const right = this.parseUnary();
      if (operator === '*') left = toNumber(left) * toNumber(right);
      else if (operator === '/') left = toNumber(left) / toNumber(right);
      else left = toNumber(left) % toNumber(right);
    }
    return left;
  }

  private parseUnary(): unknown {
    if (this.matchOperator('!')) return !Boolean(this.parseUnary());
    if (this.matchOperator('-')) return -toNumber(this.parseUnary());
    if (this.matchOperator('+')) return toNumber(this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const token = this.consume();
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'string') return token.value;
    if (token.kind === 'punctuation' && token.value === '(') {
      const value = this.parseOr();
      this.expectPunctuation(')');
      return value;
    }
    if (token.kind !== 'identifier') this.fail('此处需要字面量、变量或括号', token);

    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    if (token.value === 'undefined') return undefined;
    if (token.value === 'get') return this.parseGetCall();
    if (token.value === 'vars') return this.parseVariableAccess();
    this.fail(`不允许使用标识符“${token.value}”`, token);
  }

  private parseGetCall(): unknown {
    this.expectPunctuation('(');
    const key = this.parseOr();
    this.expectPunctuation(')');
    return safeGet(this.variables, String(key));
  }

  private parseVariableAccess(): unknown {
    let value: unknown = this.variables;
    let accessed = false;
    while (true) {
      if (this.matchPunctuation('.')) {
        const property = this.consume();
        if (property.kind !== 'identifier') this.fail('点号后需要属性名', property);
        if (property.value === 'get' && this.matchPunctuation('(')) {
          const key = this.parseOr();
          this.expectPunctuation(')');
          value = safeGet(this.variables, String(key));
        } else {
          value = safeGet(value, property.value);
        }
        accessed = true;
        continue;
      }
      if (this.matchPunctuation('[')) {
        const key = this.parseOr();
        this.expectPunctuation(']');
        value = safeGet(value, String(key));
        accessed = true;
        continue;
      }
      break;
    }
    return accessed ? value : this.variables;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: 'eof', value: '', offset: 0 };
  }

  private consume(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private peekIsOperator(...operators: string[]): boolean {
    const token = this.peek();
    return token.kind === 'operator' && operators.includes(token.value);
  }

  private matchOperator(operator: string): boolean {
    if (!this.peekIsOperator(operator)) return false;
    this.consume();
    return true;
  }

  private matchPunctuation(value: string): boolean {
    const token = this.peek();
    if (token.kind !== 'punctuation' || token.value !== value) return false;
    this.consume();
    return true;
  }

  private expectPunctuation(value: string): void {
    const token = this.consume();
    if (token.kind !== 'punctuation' || token.value !== value) this.fail(`缺少“${value}”`, token);
  }

  private fail(message: string, token: Token): never {
    throw new Error(`${message}（位置 ${token.offset + 1}）`);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) { index += 1; continue; }

    if (/\d/.test(char) || (char === '.' && /\d/.test(source[index + 1] ?? ''))) {
      const start = index;
      index += 1;
      while (/[\d_]/.test(source[index] ?? '')) index += 1;
      if (source[index] === '.') {
        index += 1;
        while (/[\d_]/.test(source[index] ?? '')) index += 1;
      }
      const value = source.slice(start, index).replaceAll('_', '');
      if (!Number.isFinite(Number(value))) throw new Error(`数字格式错误（位置 ${start + 1}）`);
      tokens.push({ kind: 'number', value, offset: start });
      continue;
    }

    if (char === '"' || char === "'") {
      const start = index;
      const quote = char;
      index += 1;
      let value = '';
      let closed = false;
      while (index < source.length) {
        const current = source[index]!;
        index += 1;
        if (current === quote) { closed = true; break; }
        if (current === '\\') {
          if (index >= source.length) break;
          const escaped = source[index]!;
          index += 1;
          const replacements: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
          value += replacements[escaped] ?? escaped;
        } else {
          value += current;
        }
      }
      if (!closed) throw new Error(`字符串没有闭合（位置 ${start + 1}）`);
      tokens.push({ kind: 'string', value, offset: start });
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (/[A-Za-z0-9_$]/.test(source[index] ?? '')) index += 1;
      tokens.push({ kind: 'identifier', value: source.slice(start, index), offset: start });
      continue;
    }

    const operator = ['===', '!==', '&&', '||', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '!', '<', '>']
      .find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ kind: 'operator', value: operator, offset: index });
      index += operator.length;
      continue;
    }

    if ('().[]'.includes(char)) {
      tokens.push({ kind: 'punctuation', value: char, offset: index });
      index += 1;
      continue;
    }
    throw new Error(`不支持字符“${char}”（位置 ${index + 1}）`);
  }
  tokens.push({ kind: 'eof', value: '', offset: source.length });
  return tokens;
}

function safeGet(value: unknown, key: string): unknown {
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') return undefined;
  if (value == null || (typeof value !== 'object' && typeof value !== 'string')) return undefined;
  if (typeof value === 'string') return /^\d+$/.test(key) ? value[Number(key)] : undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function looselyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if ((left == null && right == null)) return true;
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  return String(left) === String(right);
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' || typeof right === 'number') return toNumber(left) - toNumber(right);
  return String(left).localeCompare(String(right));
}

function toNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`“${String(value)}”不是有效数字`);
  return number;
}
