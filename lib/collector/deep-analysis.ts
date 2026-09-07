import { ETF_TICKERS } from './core.ts';
import { DEEP_ANALYSIS_MIN_SCORE } from './deep-analysis-policy.ts';
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
  'VWCE',
  'IWDA',
  'EIMI',
  'SXR8',
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
export type FlairPolicy =
  | 'observe-only'
  | 'reject-matched'
  | 'require-accepted';

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
  ['backtest', /\bbacktest\w*\b/i],
  ['CAGR', /\bCAGR\b/i],
  ['Sharpe', /\bSharpe\b/i],
  ['drawdown', /\bdrawdowns?\b/i],
  ['sequence of returns', /\bsequence[ -]+of[ -]+returns\b/i],
  ['SWR', /\bSWR\b/i],
  ['Monte Carlo', /\bMonte[ -]+Carlo\b/i],
  ['CAPE', /\bCAPE\b/i],
  ['equity risk premium', /\bequity[ -]+risk[ -]+premium\b/i],
  ['correlation', /\bcorrelations?\b/i],
  ['tax drag', /\btax[ -]+drag\b/i],
  ['three-fund', /\bthree[ -]+fund\b/i],
  ['target date', /\btarget[ -]+date\b/i],
  ['covered call', /\bcovered[ -]+calls?\b/i],
  ['buffer', /\bbuffers?\b/i],
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
  'portfoliovisualizer.com',
  'testfol.io',
  'morningstar.com',
  'etf.com',
  'i.redd.it',
  'preview.redd.it',
  'imgur.com',
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
    structure: {
      headings: boolean;
      table: boolean;
      numberedList: boolean;
      bold: boolean;
    };
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
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (
        (host === 'bogleheads.org' || host.endsWith('.bogleheads.org')) &&
        /^\/wiki(?:\/|$)/i.test(url.pathname)
      )
        sources.add('bogleheads.org/wiki');
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

/** Local queue score (90 max before interaction); AI alone decides editorial quality. */
export function scoreDeepAnalysis(
  post: DeepPost,
  flairPolicy: FlairPolicy = 'observe-only',
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
  if (flairPolicy !== 'observe-only' && flairDecision === 'rejected')
    reasons.push('rejected_flair');
  if (flairPolicy === 'require-accepted' && flairDecision === 'unclassified')
    reasons.push('unclassified_flair');

  const characters = Array.from(body).length;
  if (characters < 1000) reasons.push('too_short');
  const markdown = body.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm, '');
  const structure = {
    headings:
      /^ {0,3}#{1,6}\s+\S/m.test(markdown) ||
      /^\S[^\n]*\n(?:={3,}|-{3,})\s*$/m.test(markdown),
    table:
      /^\s*\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/m.test(
        markdown,
      ),
    numberedList: /^\s{0,3}(?:\d+[.)]|[-+*])\s+\S/m.test(markdown),
    bold: /(?:\*\*[^*\n]+\*\*|__[^_\n]+__)/.test(markdown),
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
      characters >= 3500
        ? 25
        : characters >= 2000
          ? 18
          : characters >= 1000
            ? 10
            : 0,
    structure: Math.min(
      15,
      Object.values(structure).filter(Boolean).length * 4,
    ),
    dataDensity: Math.min(20, 5 * Math.log2(1 + density)),
    primarySources: Math.min(15, sources.length * 5),
    topic: Math.min(15, 3 * Math.log2(1 + tickers.length + macros.length)),
    authorFlair: 0,
    questionPenalty: characters < 2000 && /[?？]$/.test(title) ? -5 : 0,
    helpPenalty: /\b(?:should\s+I|help|advice|beginner)\b/i.test(title)
      ? -10
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
    finalist: reasons.length === 0 && score >= DEEP_ANALYSIS_MIN_SCORE,
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
