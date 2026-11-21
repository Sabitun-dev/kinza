// Numbers in Uzbek (Latin) words, for documents: 1250000 → "Bir million ikki yuz ellik ming".

const ONES = ['', 'bir', 'ikki', 'uch', "to'rt", 'besh', 'olti', 'yetti', 'sakkiz', "to'qqiz"];
const TENS = ['', "o'n", 'yigirma', "o'ttiz", 'qirq', 'ellik', 'oltmish', 'yetmish', 'sakson', "to'qson"];
const SCALES = ['', 'ming', 'million', 'milliard', 'trillion'];

function under1000(n: number): string[] {
  const words: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  if (h) words.push(ONES[h], 'yuz');
  if (t) words.push(TENS[t]);
  if (o) words.push(ONES[o]);
  return words;
}

export function numberToUzWords(n: number): string {
  n = Math.round(n);
  if (n === 0) return 'Nol';
  const negative = n < 0;
  let rest = Math.abs(n);
  const groups: string[][] = [];
  let scale = 0;
  while (rest > 0) {
    const chunk = rest % 1000;
    if (chunk) groups.unshift([...under1000(chunk), SCALES[scale]].filter(Boolean));
    rest = Math.floor(rest / 1000);
    scale++;
  }
  const text = (negative ? ['minus'] : []).concat(...groups).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 1250000 → "Bir million ikki yuz ellik ming so'm" */
export function moneyToUzWords(n: number): string {
  return `${numberToUzWords(n)} so'm`;
}
