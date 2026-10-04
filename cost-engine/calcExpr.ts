// 工程量计算式求值 —— 确定性递归下降解析器，禁用 eval。
// 支持: + - * / × ÷ ( ) % 和中文全角符号；数字可带千分位逗号。
// 例: "3层×12个 + 15" → 先剥离单位词再求值；"12.5*(2+3)" → 62.5

const UNIT_WORDS = /[a-zA-Z一-龥㎡³]+/g;

export function evalExpr(src: string): number {
  const marked = src
    .replace(/,/g, "")
    .replace(/[×✕✖]/g, "*")
    // 数字间的 x 是乘号记号（造价习惯写法 3x12、4x35）；不转会被当字母剥掉静默拼数
    .replace(/(\d)\s*[xX](?=\s*\d)/g, "$1*")
    // 科学计数法 e 占位保护：UNIT_WORDS 会把 e 当字母剥掉（1e10→110、2.5e-3→-2）
    .replace(/(\d)\s*([eE])\s*([+-]?\d)/g, "$1@$3")
    .replace(/[÷]/g, "/")
    .replace(/[（【]/g, "(")
    .replace(/[）】]/g, ")")
    .replace(/[＋]/g, "+")
    .replace(/[－—–]/g, "-")
    // 单位词剥成哨兵 # 而非空串——「3米2米」「3ab12」剥完剩 3#2，
    // 数字间夹文字说明源式缺运算符，报错而不是静默拼成 32/312
    .replace(UNIT_WORDS, "#")
    .replace(/\s/g, "");
  if (!marked || marked.replace(/#/g, "") === "") throw new Error("表达式为空");
  if (/[\d.]#[\d.]/.test(marked))
    throw new Error("表达式中数字与文字之间缺运算符（如应为 3米×2米 或 3米+2米）");
  const cleaned = marked.replace(/#/g, "").replace(/@/g, "e");
  if (!/^[\d+\-*/().%e]+$/.test(cleaned)) throw new Error(`无法识别的表达式片段`);

  let i = 0;
  let depth = 0; // 括号嵌套深度上限：超长算式抛明确错误而不是栈溢出
  const MAX_DEPTH = 200;
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
    if (peek() === "(") {
      if (++depth > MAX_DEPTH) throw new Error("括号嵌套过深");
      eat("("); v = expr(); eat(")"); depth--;
    }
    else {
      const m = /^[\d.]+(?:e[+-]?\d+)?/.exec(cleaned.slice(i));
      if (!m) throw new Error(`位置 ${i} 处期望数字`);
      // 「1.2.3」这类多小数点片段不能静默截成 1.2——造价式里它几乎总是录入错误
      if (!/^\d+(\.\d+)?(e[+-]?\d+)?$/.test(m[0]))
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
