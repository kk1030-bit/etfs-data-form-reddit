import { ETF_TICKERS } from './core.ts';
import type { DeepPost } from './deep-analysis-source.ts';

// This experiment does not change the hourly Top 5 whitelist or ranking.
export const DEEP_ETF_TICKERS = new Set([
  ...ETF_TICKERS,
  'SSO',
  'QLD',
  'TMF',
  'TMV',
  'EDV',
  'ZROZ',
  'RSSB',
  'RSST',
  'GOVZ',
  'KMLM',
  'DBMF',
  'SPYM',
]);
export const BOGLEHEADS_FUND_TICKERS = new Set([
  'VTSAX',
  'VFIAX',
  'VTIAX',
  'VBTLX',
  'VTWAX',
  'VBIAX',
  'VUSXX',
  'VMFXX',
  'FSKAX',
  'FTIHX',
  'FXAIX',
  'FXNAX',
  'FZROX',
  'FZILX',
  'SWTSX',
  'SWPPX',
]);
export const ACCEPT_DEEP_FLAIR =
  /theory|discussion|analysis|macro|commentary|backtest|research|education/i;
export const REJECT_DEEP_FLAIR = /question|advice|review|help|rate/i;
export type FlairPolicy = 'reject-matched' | 'require-accepted';

const macroTerms: Array<[string, RegExp]> = [
  ['Fed', /\bFed\b/i],
  ['FOMC', /\bFOMC\b/i],
  ['yield curve', /\byield[ -]+curve\b/i],
  ['CPI', /\bCPI\b/i],
  ['inflation', /\binflation\b/i],
  ['recession', /\brecession\b/i],
  ['duration', /\bduration\b/i],
  ['asset allocation', /\basset[ -]+allocation\b/i],
  ['rebalanc', /\brebalanc\w*/i],
  ['glide path', /\bglide[ -]+path\b/i],
  ['sequence risk', /\bsequence[ -]+risk\b/i],
  ['withdrawal rate', /\bwithdrawal[ -]+rate\b/i],
  ['factor', /\bfactors?\b/i],
  ['expense ratio', /\bexpense[ -]+ratios?\b/i],
  ['tax-loss', /\btax[ -]+loss\b/i],
  ['TIPS', /\bTIPS\b/i],
  ['treasury', /\btreasur(?:y|ies)\b/i],
];
const primaryDomains = [
  'sec.gov',
  'fred.stlouisfed.org',
  'bls.gov',
  'treasury.gov',
  'vanguard.com',
  'vanguard.co.uk',
  'vanguard.com.au',
  'ishares.com',
  'schwab.com',
  'schwabassetmanagement.com',
  'invesco.com',
  'ssrn.com',
  'nber.org',
];

export type DeepAnalysisScore = {
  eligible: boolean;
  finalist: boolean;
  score: number;
  rejectionReasons: string[];
  flairDecision: 'accepted' | 'rejected' | 'unclassified';
  details: {
    characters: number;
    tickers: string[];
    macroTerms: string[];
    unknownDollarTickers: string[];
    structure: { headings: boolean; table: boolean; numberedList: boolean };
    numberCount: number;
    numbersPerThousandCharacters: number;
    primarySources: string[];
    authorFlairClaim: boolean;
  };
  points: {
    length: number;
    structure: number;
    dataDensity: number;
    primarySources: number;
    topic: number;
    authorFlair: number;
    questionPenalty: number;
    helpPenalty: number;
  };
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function primarySources(body: string): string[] {
  const sources = new Set<string>();
  for (const raw of body.match(/https?:\/\/[^\s<>"\])]+/gi) ?? []) {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      const domain = primaryDomains.find(
        (item) => host === item || host.endsWith(`.${item}`),
      );
      if (domain) sources.add(domain);
    } catch {
      /* Malformed text is not a source citation. */
    }
  }
  return [...sources].sort();
}

/** Approved initial formula only; no AI, author history or commenter network calls. */
export function scoreDeepAnalysis(
  post: DeepPost,
  flairPolicy: FlairPolicy,
): DeepAnalysisScore {
  const title = text(post.title);
  const body = text(post.selftext);
  const flair = text(post.link_flair_text);
  const authorFlair = text(post.author_flair_text);
  const symbols = new Set(DEEP_ETF_TICKERS);
  if (post.subreddit.toLowerCase() === 'bogleheads')
    for (const symbol of BOGLEHEADS_FUND_TICKERS) symbols.add(symbol);
  // Ticker symbols are uppercase whole tokens; ordinary "tip" is not the TIP fund.
  const tickers = [
    ...new Set(
      (body.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) ?? []).filter((token) =>
        symbols.has(token),
      ),
    ),
  ];
  const macros = macroTerms
    .filter(([, pattern]) => pattern.test(body))
    .map(([term]) => term);
  const unknownDollarTickers = [
    ...new Set(
      [
        ...title.matchAll(
          /\$([A-Za-z]{1,6}(?:[.-][A-Za-z]{1,2})?)(?![A-Za-z0-9])/g,
        ),
      ]
        .map((match) => match[1].toUpperCase())
        .filter((token) => !symbols.has(token)),
    ),
  ];
  const flairDecision = REJECT_DEEP_FLAIR.test(flair)
    ? 'rejected'
    : ACCEPT_DEEP_FLAIR.test(flair)
      ? 'accepted'
      : 'unclassified';
  const reasons: string[] = [];
  if (!body || /^\[(removed|deleted)\]$/i.test(body))
    reasons.push('removed_or_empty');
  if (post.is_self !== true) reasons.push('not_self_post');
  if (/^AutoModerator$/i.test(text(post.author))) reasons.push('automoderator');
  if (post.over_18 === true) reasons.push('adult');
  if (/\b(?:Daily|Weekly|Megathread)\b/i.test(`${title}\n${flair}`))
    reasons.push('recurring_thread');
  if (!tickers.length && macros.length < 3) reasons.push('off_scope');
  if (unknownDollarTickers.length) reasons.push('single_stock_title');
  if (
    /long\s+thesis|short\s+thesis|company\s+analysis|stock\s+analysis/i.test(
      flair,
    ) &&
    macros.length < 3
  )
    reasons.push('single_stock_flair');
  if (flairDecision === 'rejected') reasons.push('rejected_flair');
  if (flairPolicy === 'require-accepted' && flairDecision === 'unclassified')
    reasons.push('unclassified_flair');

  const characters = Array.from(body).length;
  const markdown = body.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm, '');
  const structure = {
    headings:
      /^ {0,3}#{1,6}\s+\S/m.test(markdown) ||
      /^\S[^\n]*\n(?:={3,}|-{3,})\s*$/m.test(markdown),
    table:
      /^\s*\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/m.test(
        markdown,
      ),
    numberedList: /^\s{0,3}\d+[.)]\s+\S/m.test(markdown),
  };
  // A number with a trailing % is one item, not two. URL IDs are not data values.
  const numericText = body.replace(/https?:\/\/\S+/gi, '');
  const numberCount = [
    ...numericText.matchAll(
      /(?:^|[^A-Za-z0-9_])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![A-Za-z0-9_])/g,
    ),
  ].length;
  const density = characters ? (numberCount * 1000) / characters : 0;
  const sources = primarySources(body);
  const authorFlairClaim = /\b(?:CFA|CPA|PM)\b|analyst|quant/i.test(
    authorFlair,
  );
  const points = {
    length:
      characters > 6000
        ? 35
        : characters >= 3000
          ? 30
          : characters >= 1500
            ? 20
            : 0,
    structure: Object.values(structure).filter(Boolean).length * 5,
    dataDensity: Math.min(15, density),
    primarySources: Math.min(15, sources.length * 5),
    topic: Math.min(10, tickers.length + macros.length),
    authorFlair: authorFlairClaim ? 5 : 0,
    questionPenalty: /[?？]$/.test(title) ? -15 : 0,
    helpPenalty: /\b(?:should\s+I|help|advice|new\s+to|rate\s+my)\b/i.test(
      title,
    )
      ? -20
      : 0,
  };
  const score =
    Math.round(
      Math.min(
        100,
        Math.max(
          0,
          Object.values(points).reduce((total, value) => total + value, 0),
        ),
      ) * 100,
    ) / 100;
  return {
    eligible: reasons.length === 0,
    finalist: reasons.length === 0 && score >= 55,
    score,
    rejectionReasons: reasons,
    flairDecision,
    details: {
      characters,
      tickers,
      macroTerms: macros,
      unknownDollarTickers,
      structure,
      numberCount,
      numbersPerThousandCharacters: density,
      primarySources: sources,
      authorFlairClaim,
    },
    points,
  };
}
