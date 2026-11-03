// Regras do Beer Chess.
// Edite à vontade: o texto de `/beerchess regras` é gerado a partir deste objeto.
// Unidade: goles (sips). `loserGlasses` é em copos.

export const DEFAULT_RULES = Object.freeze({
  // Perdeu peça -> bebe o valor clássico dela
  pieces: Object.freeze({ p: 1, n: 3, b: 3, r: 5, q: 9 }),
  check: 1, // quem leva xeque bebe (no xeque-mate não conta: aí é o copo)
  enPassant: 2, // bônus para quem perde o peão en passant (pela humilhação)
  promotion: 3, // o adversário de quem promove bebe
  castle: 1, // roque: brinde, os dois bebem
  draw: 3, // empate: os dois bebem
  loserGlasses: 1, // quem perde vira o copo (0 desliga)
});

export const INTENSITIES = Object.freeze({
  normal: Object.freeze({ key: 'normal', label: 'normal', factor: 1 }),
  leve: Object.freeze({ key: 'leve', label: 'leve (metade)', factor: 0.5 }),
});

export function normalizeIntensity(value) {
  return Object.hasOwn(INTENSITIES, value) ? value : 'normal';
}

/** Goles ajustados pela intensidade (arredonda para cima; nunca zera uma regra ligada). */
export function scaleSips(n, intensity = 'normal') {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const factor = INTENSITIES[normalizeIntensity(intensity)].factor;
  return Math.max(1, Math.ceil(n * factor));
}

/** Copos ajustados pela intensidade (0,5 = meio copo). */
export function scaleGlasses(n, intensity = 'normal') {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * INTENSITIES[normalizeIntensity(intensity)].factor;
}
