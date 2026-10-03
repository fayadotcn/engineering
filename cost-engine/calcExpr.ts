// 工程量计算式求值 —— 确定性递归下降解析器，禁用 eval。
// 支持: + - * / × ÷ ( ) % 和中文全角符号；数字可带千分位逗号。
// 例: "3层×12个 + 15" → 先剥离单位词再求值；"12.5*(2+3)" → 62.5

const UNIT_WORDS = /[a-zA-Z一-龥㎡³]+/g;

export function evalExpr(src: string): number {
  const cleaned = src
    .replace(/,/g, "")
    .replace(/[×✕✖]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/[（【]/g, "(")
    .replace(/[）】]/g, ")")
    .replace(/[＋]/g, "+")
    .replace(/[－—–]/g, "-")
    .replace(UNIT_WORDS, "") // 剥离单位/说明文字（m、层、个、米…）
    .replace(/\s/g, "");
  if (!cleaned) throw new Error("表达式为空");
  if (!/^[\d+\-*/().%]+$/.test(cleaned)) throw new Error(`无法识别的表达式片段`);

  let i = 0;
  const peek = () => cleaned[i];
  const eat = (ch?: string) => {
    if (ch !== undefined && cleaned[i] !== ch) throw new Error(`期望 ${ch}，遇到 ${cleaned[i] ?? "结尾"}`);
    return cleaned[i++];
  };

  function expr(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") v = eat() === "+" ? v + term() : v - term();
    return v;
  }
  function term(): number {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = eat();
      const r = factor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function factor(): number {
    if (peek() === "-") { eat("-"); return -factor(); }
    if (peek() === "+") { eat("+"); return factor(); }
    let v: number;
    if (peek() === "(") { eat("("); v = expr(); eat(")"); }
    else {
      const m = /^[\d.]+/.exec(cleaned.slice(i));
      if (!m) throw new Error(`位置 ${i} 处期望数字`);
      // 「1.2.3」这类多小数点片段不能静默截成 1.2——造价式里它几乎总是录入错误
      if ((m[0].match(/\./g) ?? []).length > 1 || !/^\d+(\.\d+)?$/.test(m[0]))
        throw new Error(`位置 ${i} 处数字「${m[0]}」格式非法`);
      i += m[0].length;
      v = parseFloat(m[0]);
      if (isNaN(v)) throw new Error("非法数字");
    }
    while (peek() === "%") { eat("%"); v /= 100; }
    return v;
  }

  const result = expr();
  if (i < cleaned.length) throw new Error(`表达式在位置 ${i} 处有多余内容`);
  if (!isFinite(result)) throw new Error("计算结果非有限数（除零？）");
  return result;
}
