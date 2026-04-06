import vm from "node:vm";

const MAX_EXECUTION_TIME_MS = 3000;
const MAX_OUTPUT_SIZE = 50000;

interface ExecutionResult {
  success: boolean;
  output: any;
  error?: string;
  latencyMs: number;
}

function sanitizeResultDeclarations(code: string): string {
  return code
    .replace(/\b(const|let|var)\s+__result__\s*=/g, '__result__ =')
    .replace(/\b(const|let|var)\s+__result__\s*;/g, '');
}

const WHITELISTED_FETCH_DOMAINS = [
  "api.coingecko.com",
  "api.dexscreener.com",
  "api.llama.fi",
  "coins.llama.fi",
  "yields.llama.fi",
  "api.geckoterminal.com",
  "api.bscscan.com",
  "api.basescan.org",
  "api.etherscan.io",
  "pro-api.coinmarketcap.com",
  "min-api.cryptocompare.com",
  "api.alternative.me",
];

function createSkillAI(): (model: string, systemPrompt: string, userMessage: string, options?: { maxTokens?: number; temperature?: number }) => Promise<string> {
  return async (model: string, systemPrompt: string, userMessage: string, options?: { maxTokens?: number; temperature?: number }): Promise<string> => {
    try {
      const { runInferenceWithFallback } = await import("./inference");
      const result = await runInferenceWithFallback(
        ["akash", "hyperbolic"],
        model || undefined,
        userMessage,
        {
          systemPrompt,
          temperature: options?.temperature ?? 0.7,
          maxTokens: options?.maxTokens ?? 1000,
        }
      );
      if (result.live && result.text) {
        return result.text;
      }
      return "[AI_UNAVAILABLE] Inference providers are temporarily offline.";
    } catch (e: any) {
      return `[AI_ERROR] ${e.message?.substring(0, 200) || "Unknown error"}`;
    }
  };
}

function createSkillAIJson(): (model: string, systemPrompt: string, userMessage: string) => Promise<any> {
  const aiChat = createSkillAI();
  return async (model: string, systemPrompt: string, userMessage: string): Promise<any> => {
    const raw = await aiChat(model, systemPrompt + "\nRespond ONLY with valid JSON. No markdown, no code blocks.", userMessage, { temperature: 0.1 });
    if (raw.startsWith("[AI_")) return { error: raw };
    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { raw, parseError: "Failed to parse AI response as JSON" };
    }
  };
}

function createSandboxFetch(timeout = 5000): (url: string) => Promise<any> {
  return async (url: string) => {
    try {
      const parsed = new URL(url);
      if (!WHITELISTED_FETCH_DOMAINS.includes(parsed.hostname)) {
        return { ok: false, error: `Domain not whitelisted: ${parsed.hostname}`, status: 403 };
      }
      if (parsed.protocol !== "https:") {
        return { ok: false, error: "Only HTTPS allowed", status: 400 };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { signal: controller.signal, redirect: "error", headers: { "User-Agent": "BUILD4-Agent/1.0" } });
        clearTimeout(timer);
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch {}
        return { ok: res.ok, status: res.status, data: json || text };
      } catch (fetchErr: any) {
        clearTimeout(timer);
        return { ok: false, error: fetchErr.message || "Fetch failed", status: 0 };
      }
    } catch (parseErr: any) {
      return { ok: false, error: `Invalid URL: ${parseErr.message}`, status: 400 };
    }
  };
}

const SAFE_GLOBALS = {
  Math,
  JSON,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Date,
  RegExp,
  Map,
  Set,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  btoa: (s: string) => Buffer.from(s).toString("base64"),
  atob: (s: string) => Buffer.from(s, "base64").toString("utf-8"),
  console: {
    log: () => {},
    warn: () => {},
    error: () => {},
  },
};

function validateInputAgainstSchema(input: Record<string, any>, schemaStr: string | null): string | null {
  if (!schemaStr) return null;
  try {
    const schema = JSON.parse(schemaStr);
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in input)) {
          return `Missing required field: ${key}`;
        }
      }
    }
    if (schema.properties) {
      for (const [key, spec] of Object.entries(schema.properties) as [string, any][]) {
        if (key in input && spec.type) {
          const val = input[key];
          const actualType = Array.isArray(val) ? "array" : typeof val;
          if (spec.type !== actualType && !(spec.type === "number" && actualType === "string" && !isNaN(Number(val)))) {
            return `Field "${key}" expected type "${spec.type}", got "${actualType}"`;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function executeSkillCode(code: string, input: Record<string, any>, inputSchemaStr: string | null, externalData?: Record<string, any>): ExecutionResult {
  const start = Date.now();

  const validationError = validateInputAgainstSchema(input, inputSchemaStr);
  if (validationError) {
    return { success: false, output: null, error: validationError, latencyMs: Date.now() - start };
  }

  try {
    const sanitizedCode = sanitizeResultDeclarations(code);

    const blockedPatterns = [
      /\bconstructor\b.*\bconstructor\b/i,
      /\bprocess\b/,
      /\brequire\b/,
      /\bimport\b\s*\(/,
      /\bglobal(?:This)?\b/,
      /\b__proto__\b/,
      /\bFunction\b\s*\(/,
      /\beval\b\s*\(/,
      /\bchild_process\b/,
      /\bexecSync\b/,
      /\bspawnSync\b/,
      /\bfs\b\s*\.\s*(?:read|write|unlink|mkdir)/,
    ];
    for (const pat of blockedPatterns) {
      if (pat.test(sanitizedCode)) {
        return { success: false, output: null, error: `Blocked: potentially unsafe code pattern detected`, latencyMs: Date.now() - start };
      }
    }

    const wrappedCode = `
      "use strict";
      const input = __INPUT__;
      ${externalData ? 'const __EXTERNAL_DATA__ = __EXT_DATA__;' : 'const __EXTERNAL_DATA__ = {};'}
      var __result__;
      ${sanitizedCode}
      __result__;
    `;

    const contextVars: Record<string, any> = {
      ...SAFE_GLOBALS,
      __INPUT__: JSON.parse(JSON.stringify(input)),
    };
    if (externalData) {
      contextVars.__EXT_DATA__ = JSON.parse(JSON.stringify(externalData));
    }

    const context = vm.createContext(contextVars);

    const script = new vm.Script(wrappedCode, { filename: "skill.js" });
    const rawOutput = script.runInContext(context, { timeout: MAX_EXECUTION_TIME_MS });

    let output = rawOutput;
    if (typeof output === "undefined") {
      output = null;
    }

    const outputStr = JSON.stringify(output);
    if (outputStr && outputStr.length > MAX_OUTPUT_SIZE) {
      return { success: false, output: null, error: "Output exceeds maximum size limit", latencyMs: Date.now() - start };
    }

    return { success: true, output, latencyMs: Date.now() - start };
  } catch (err: any) {
    const errorMsg = err.message || "Unknown execution error";
    const cleanError = errorMsg.includes("Script execution timed out")
      ? "Execution timed out (3s limit)"
      : errorMsg.substring(0, 500);

    return { success: false, output: null, error: cleanError, latencyMs: Date.now() - start };
  }
}

let cachedExternalData: { data: Record<string, any>; fetchedAt: number } | null = null;
const EXTERNAL_DATA_CACHE_MS = 60_000;

export async function fetchExternalData(): Promise<Record<string, any>> {
  if (cachedExternalData && Date.now() - cachedExternalData.fetchedAt < EXTERNAL_DATA_CACHE_MS) {
    return cachedExternalData.data;
  }

  const data: Record<string, any> = {
    timestamp: Date.now(),
    timestampISO: new Date().toISOString(),
    blockHeights: {},
    cryptoPrices: {},
  };

  try {
    const priceRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,ethereum,bitcoin,solana&vs_currencies=usd&include_24hr_change=true");
    if (priceRes.ok) {
      const prices = await priceRes.json();
      data.cryptoPrices = {
        BNB: { usd: prices.binancecoin?.usd || 0, change24h: prices.binancecoin?.usd_24h_change || 0 },
        ETH: { usd: prices.ethereum?.usd || 0, change24h: prices.ethereum?.usd_24h_change || 0 },
        BTC: { usd: prices.bitcoin?.usd || 0, change24h: prices.bitcoin?.usd_24h_change || 0 },
        SOL: { usd: prices.solana?.usd || 0, change24h: prices.solana?.usd_24h_change || 0 },
      };
    }
  } catch {}

  try {
    const gasRes = await fetch("https://api.bscscan.com/api?module=gastracker&action=gasoracle");
    if (gasRes.ok) {
      const gasData = await gasRes.json();
      if (gasData.result) {
        data.gasPrice = {
          bnbChain: { low: gasData.result.SafeGasPrice, standard: gasData.result.ProposeGasPrice, fast: gasData.result.FastGasPrice },
        };
      }
    }
  } catch {}

  data.blockHeights = {
    bnbChain: "latest",
    base: "latest",
    xlayer: "latest",
  };

  cachedExternalData = { data, fetchedAt: Date.now() };
  return data;
}

export function executeSkillWithExternalData(code: string, input: Record<string, any>, inputSchemaStr: string | null, externalData: Record<string, any>): ExecutionResult {
  return executeSkillCode(code, input, inputSchemaStr, externalData);
}

const ASYNC_TIMEOUT_MS = 30000;

export async function executeSkillAsync(code: string, input: Record<string, any>, inputSchemaStr: string | null, externalData?: Record<string, any>): Promise<ExecutionResult> {
  const start = Date.now();

  const validationError = validateInputAgainstSchema(input, inputSchemaStr);
  if (validationError) {
    return { success: false, output: null, error: validationError, latencyMs: Date.now() - start };
  }

  try {
    const sanitizedCode = sanitizeResultDeclarations(code);
    const sandboxFetch = createSandboxFetch(5000);
    let timedOut = false;
    let checkInterval: NodeJS.Timeout | undefined;

    const wrappedCode = `
      "use strict";
      (async () => {
        const input = __INPUT__;
        const __EXTERNAL_DATA__ = __EXT_DATA__;
        var __result__;
        ${sanitizedCode}
        return __result__;
      })()
    `;

    const contextVars: Record<string, any> = {
      ...SAFE_GLOBALS,
      __INPUT__: JSON.parse(JSON.stringify(input)),
      __EXT_DATA__: JSON.parse(JSON.stringify(externalData || {})),
      safeFetch: sandboxFetch,
      aiChat: createSkillAI(),
      aiJson: createSkillAIJson(),
    };

    const context = vm.createContext(contextVars);
    const script = new vm.Script(wrappedCode, { filename: "skill-async.js" });
    const promise = script.runInContext(context, { timeout: MAX_EXECUTION_TIME_MS });

    const output = await Promise.race([
      promise,
      new Promise((_, reject) => {
        const hardDeadline = Date.now() + ASYNC_TIMEOUT_MS;
        checkInterval = setInterval(() => {
          if (Date.now() > hardDeadline) {
            timedOut = true;
            reject(new Error("Async execution timed out"));
          }
        }, 100);
      }),
    ]);

    if (checkInterval) clearInterval(checkInterval);

    const outputStr = JSON.stringify(output);
    if (outputStr && outputStr.length > MAX_OUTPUT_SIZE) {
      return { success: false, output: null, error: "Output exceeds maximum size limit", latencyMs: Date.now() - start };
    }

    return { success: true, output: output ?? null, latencyMs: Date.now() - start };
  } catch (err: any) {
    const errorMsg = err.message || "Unknown execution error";
    const cleanError = errorMsg.includes("timed out")
      ? "Execution timed out"
      : errorMsg.substring(0, 500);
    return { success: false, output: null, error: cleanError, latencyMs: Date.now() - start };
  }
}

export function validateSkillCode(code: string): { valid: boolean; error?: string } {
  const forbidden = [
    /require\s*\(/,
    /import\s+/,
    /process\./,
    /global\./,
    /globalThis/,
    /eval\s*\(/,
    /Function\s*\(/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /WebSocket/,
    /child_process/,
    /\bfs\./,
    /\bpath\./,
    /\bos\./,
    /\bnet\./,
    /\bhttp\./,
    /\bhttps\./,
    /\bcrypto\./,
    /__proto__/,
    /constructor\s*\[/,
    /Proxy\s*\(/,
    /Reflect\./,
  ];

  for (const pattern of forbidden) {
    if (pattern.test(code)) {
      return { valid: false, error: `Forbidden pattern detected: ${pattern.source}` };
    }
  }

  try {
    const sanitized = sanitizeResultDeclarations(code);
    const usesAsync = code.includes("await ") || code.includes("safeFetch");
    const wrapper = usesAsync
      ? `"use strict"; (async () => { const input = {}; const __EXTERNAL_DATA__ = {}; const safeFetch = async (url) => ({}); var __result__; ${sanitized}; return __result__; })()`
      : `"use strict"; const input = {}; var __result__; ${sanitized}`;
    new vm.Script(wrapper, { filename: "validate.js" });
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: `Syntax error: ${err.message}` };
  }
}

export function generateSkillCodePrompt(category: string, agentName: string, agentBio: string): string {
  return `You are ${agentName}, an autonomous AI agent creating a new EXECUTABLE JavaScript skill for the BUILD4 marketplace.
Your expertise: ${agentBio || "general AI capabilities"}.

Create a UNIQUE, CREATIVE skill in the "${category}" category. The skill must be a complete, working JavaScript snippet.

CONSTRAINTS:
- The variable \`input\` is already defined. Read fields from it like \`input.text\`, \`input.data\`, etc.
- The variable \`__result__\` is already declared. ASSIGN your output to it: \`__result__ = { ... }\`. Do NOT use const/let/var to declare __result__.
- \`__EXTERNAL_DATA__\` contains live market data: \`__EXTERNAL_DATA__.cryptoPrices\` (BNB/ETH/BTC/SOL with usd and change24h), \`__EXTERNAL_DATA__.gasPrice\`, \`__EXTERNAL_DATA__.timestampISO\`.
- \`safeFetch(url)\` is available for HTTP calls to whitelisted APIs. Returns \`{ ok, status, data }\`. Whitelisted: api.coingecko.com, api.dexscreener.com, api.llama.fi, coins.llama.fi, yields.llama.fi, api.geckoterminal.com, api.bscscan.com, api.basescan.org, api.etherscan.io, api.alternative.me. Use \`await safeFetch(url)\` — your code runs in an async context.
- FORBIDDEN: require(), import, fetch() (use safeFetch instead), process, global, eval, Function(), XMLHttpRequest, WebSocket, child_process, fs, path, os, net, http, https, crypto, __proto__, Proxy, Reflect
- ALLOWED: Math, JSON, String, Number, Boolean, Array, Object, Date, RegExp, Map, Set, parseInt, parseFloat, isNaN, isFinite, safeFetch
- Code must complete in under 8 seconds
- Output must be JSON-serializable and under 50KB

Respond with EXACTLY this format (no extra text before or after):
CATEGORY: ${category}
SKILL_NAME: <unique creative name, max 50 chars>
DESCRIPTION: <what it does in 1 sentence>
INPUT_SCHEMA: <valid JSON schema object on one line>
OUTPUT_SCHEMA: <valid JSON schema object on one line>
EXAMPLE_INPUT: <valid JSON object on one line>
EXAMPLE_OUTPUT: <valid JSON object on one line>
CODE:
<javascript code that reads input and assigns to __result__>
END_CODE

EXAMPLE CODE PATTERN:
\`\`\`
const data = input.data || [];
const processed = data.map(item => item.toUpperCase());
__result__ = { processed, count: processed.length };
\`\`\`

Be creative! Invent something novel and useful. Do NOT declare __result__ with const/let/var.`;
}

export function parseSkillGenerationResponse(response: string, category: string, agentName: string): {
  name: string;
  description: string;
  category: string;
  code: string;
  inputSchema: string;
  outputSchema: string;
  exampleInput: string;
  exampleOutput: string;
} | null {
  try {
    const categoryMatch = response.match(/CATEGORY:\s*(.+)/i);
    const nameMatch = response.match(/SKILL_NAME:\s*(.+)/i);
    const descMatch = response.match(/DESCRIPTION:\s*(.+)/i);
    const inputSchemaMatch = response.match(/INPUT_SCHEMA:\s*(.+)/i);
    const outputSchemaMatch = response.match(/OUTPUT_SCHEMA:\s*(.+)/i);
    const exampleInputMatch = response.match(/EXAMPLE_INPUT:\s*(.+)/i);
    const exampleOutputMatch = response.match(/EXAMPLE_OUTPUT:\s*(.+)/i);
    const codeMatch = response.match(/CODE:\s*\n([\s\S]*?)\nEND_CODE/i);

    if (!nameMatch || !codeMatch) return null;

    const name = nameMatch[1].trim().substring(0, 50);
    const description = descMatch ? descMatch[1].trim() : `AI-generated ${category} skill by ${agentName}`;
    const parsedCategory = categoryMatch ? categoryMatch[1].trim().toLowerCase().replace(/\s+/g, "-") : category;
    const code = codeMatch[1].trim();

    if (!code || code.length < 10) return null;

    let inputSchema = '{"type":"object","properties":{}}';
    let outputSchema = '{"type":"object","properties":{}}';
    let exampleInput = '{}';
    let exampleOutput = '{}';

    if (inputSchemaMatch) {
      try { JSON.parse(inputSchemaMatch[1].trim()); inputSchema = inputSchemaMatch[1].trim(); } catch {}
    }
    if (outputSchemaMatch) {
      try { JSON.parse(outputSchemaMatch[1].trim()); outputSchema = outputSchemaMatch[1].trim(); } catch {}
    }
    if (exampleInputMatch) {
      try { JSON.parse(exampleInputMatch[1].trim()); exampleInput = exampleInputMatch[1].trim(); } catch {}
    }
    if (exampleOutputMatch) {
      try { JSON.parse(exampleOutputMatch[1].trim()); exampleOutput = exampleOutputMatch[1].trim(); } catch {}
    }

    return {
      name,
      description,
      category: parsedCategory,
      code,
      inputSchema,
      outputSchema,
      exampleInput,
      exampleOutput,
    };
  } catch {
    return null;
  }
}

export const SKILL_CODE_TEMPLATES: Record<string, { code: string; inputSchema: string; outputSchema: string; exampleInput: string; exampleOutput: string }> = {
  "text-analysis": {
    code: `const text = input.text || "";
const words = text.split(/\\s+/).filter(w => w.length > 0);
const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
const chars = text.length;
const avgWordLen = words.length > 0 ? (words.reduce((s, w) => s + w.length, 0) / words.length).toFixed(1) : "0";
const topWords = {};
words.forEach(w => { const lw = w.toLowerCase().replace(/[^a-z]/g, ""); if (lw.length > 3) topWords[lw] = (topWords[lw] || 0) + 1; });
const sorted = Object.entries(topWords).sort((a, b) => b[1] - a[1]).slice(0, 10);
const __result__ = { wordCount: words.length, sentenceCount: sentences.length, charCount: chars, avgWordLength: Number(avgWordLen), topWords: Object.fromEntries(sorted), readabilityScore: Math.min(100, Math.round(50 + (sentences.length > 0 ? words.length / sentences.length : 0) * 3)) };`,
    inputSchema: '{"type":"object","required":["text"],"properties":{"text":{"type":"string","description":"Text to analyze"}}}',
    outputSchema: '{"type":"object","properties":{"wordCount":{"type":"number"},"sentenceCount":{"type":"number"},"charCount":{"type":"number"},"avgWordLength":{"type":"number"},"topWords":{"type":"object"},"readabilityScore":{"type":"number"}}}',
    exampleInput: '{"text":"The quick brown fox jumps over the lazy dog. This is a sample sentence for analysis."}',
    exampleOutput: '{"wordCount":17,"sentenceCount":2,"charCount":84,"avgWordLength":"4.2","topWords":{"quick":1,"brown":1},"readabilityScore":75}',
  },
  "data-transform": {
    code: `const data = input.data || [];
const operation = input.operation || "sort";
const field = input.field || null;
let __result__;
if (operation === "sort") {
  __result__ = { data: [...data].sort((a, b) => field ? (a[field] > b[field] ? 1 : -1) : (a > b ? 1 : -1)), count: data.length };
} else if (operation === "filter") {
  const val = input.value;
  __result__ = { data: data.filter(item => field ? item[field] === val : item === val), count: data.length };
} else if (operation === "group") {
  const groups = {};
  data.forEach(item => { const key = field ? item[field] : String(item); groups[key] = groups[key] || []; groups[key].push(item); });
  __result__ = { data: groups, count: data.length, groupCount: Object.keys(groups).length };
} else if (operation === "stats") {
  const nums = data.map(item => field ? Number(item[field]) : Number(item)).filter(n => !isNaN(n));
  const sum = nums.reduce((a, b) => a + b, 0);
  __result__ = { min: Math.min(...nums), max: Math.max(...nums), sum, avg: nums.length > 0 ? sum / nums.length : 0, count: nums.length };
} else {
  __result__ = { data, count: data.length };
}`,
    inputSchema: '{"type":"object","required":["data"],"properties":{"data":{"type":"array","description":"Array of data to transform"},"operation":{"type":"string","description":"Operation: sort, filter, group, stats"},"field":{"type":"string","description":"Field name for objects"},"value":{"description":"Value for filter operation"}}}',
    outputSchema: '{"type":"object","properties":{"data":{},"count":{"type":"number"}}}',
    exampleInput: '{"data":[3,1,4,1,5,9],"operation":"stats"}',
    exampleOutput: '{"min":1,"max":9,"sum":23,"avg":3.83,"count":6}',
  },
  "summarization": {
    code: `const text = input.text || "";
const maxSentences = input.maxSentences || 3;
const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
const words = {};
sentences.forEach((s, i) => { s.split(/\\s+/).forEach(w => { const lw = w.toLowerCase().replace(/[^a-z]/g, ""); if (lw.length > 3) words[lw] = (words[lw] || 0) + 1; }); });
const scored = sentences.map((s, i) => {
  let score = 0;
  s.split(/\\s+/).forEach(w => { const lw = w.toLowerCase().replace(/[^a-z]/g, ""); score += (words[lw] || 0); });
  if (i === 0) score *= 1.5;
  return { sentence: s, score, index: i };
});
scored.sort((a, b) => b.score - a.score);
const top = scored.slice(0, maxSentences).sort((a, b) => a.index - b.index);
const __result__ = { summary: top.map(t => t.sentence).join(". ") + ".", sentenceCount: sentences.length, compressionRatio: sentences.length > 0 ? (maxSentences / sentences.length * 100).toFixed(1) + "%" : "100%" };`,
    inputSchema: '{"type":"object","required":["text"],"properties":{"text":{"type":"string","description":"Text to summarize"},"maxSentences":{"type":"number","description":"Max sentences in summary (default 3)"}}}',
    outputSchema: '{"type":"object","properties":{"summary":{"type":"string"},"sentenceCount":{"type":"number"},"compressionRatio":{"type":"string"}}}',
    exampleInput: '{"text":"Machine learning is a subset of artificial intelligence. It allows computers to learn from data. Deep learning uses neural networks with many layers. These networks can recognize patterns in large datasets. This technology powers many modern applications.","maxSentences":2}',
    exampleOutput: '{"summary":"Machine learning is a subset of artificial intelligence. Deep learning uses neural networks with many layers.","sentenceCount":5,"compressionRatio":"40.0%"}',
  },
  "code-generation": {
    code: `const task = input.task || "hello world";
const language = input.language || "javascript";
const templates = {
  "sort": "const result = arr.sort((a, b) => a - b);",
  "reverse": "const result = str.split('').reverse().join('');",
  "capitalize": "const result = str.charAt(0).toUpperCase() + str.slice(1);",
  "slugify": "const result = str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');",
  "camelCase": "const result = str.replace(/[-_\\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');",
  "fibonacci": "function fib(n) { if (n <= 1) return n; return fib(n-1) + fib(n-2); }",
  "factorial": "function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }",
  "isPrime": "function isPrime(n) { if (n < 2) return false; for (let i = 2; i <= Math.sqrt(n); i++) { if (n % i === 0) return false; } return true; }",
};
const taskLower = task.toLowerCase();
let code = "// Custom function\\nfunction solve(input) {\\n  return input;\\n}";
for (const [key, template] of Object.entries(templates)) {
  if (taskLower.includes(key.toLowerCase())) { code = template; break; }
}
const __result__ = { code, language, task, executable: true };`,
    inputSchema: '{"type":"object","required":["task"],"properties":{"task":{"type":"string","description":"Description of code to generate"},"language":{"type":"string","description":"Target language (default: javascript)"}}}',
    outputSchema: '{"type":"object","properties":{"code":{"type":"string"},"language":{"type":"string"},"task":{"type":"string"},"executable":{"type":"boolean"}}}',
    exampleInput: '{"task":"sort an array","language":"javascript"}',
    exampleOutput: '{"code":"const result = arr.sort((a, b) => a - b);","language":"javascript","task":"sort an array","executable":true}',
  },
  "classification": {
    code: `const text = input.text || "";
const categories = input.categories || ["positive", "negative", "neutral"];
const lower = text.toLowerCase();
const positiveWords = ["good", "great", "excellent", "amazing", "love", "best", "happy", "wonderful", "fantastic", "awesome", "brilliant", "perfect"];
const negativeWords = ["bad", "terrible", "awful", "hate", "worst", "horrible", "poor", "disappointing", "ugly", "boring", "stupid", "broken"];
let posScore = 0, negScore = 0;
positiveWords.forEach(w => { if (lower.includes(w)) posScore++; });
negativeWords.forEach(w => { if (lower.includes(w)) negScore++; });
const total = posScore + negScore || 1;
let category = "neutral";
let confidence = 50;
if (posScore > negScore) { category = categories.includes("positive") ? "positive" : categories[0]; confidence = Math.min(95, 50 + (posScore / total) * 45); }
else if (negScore > posScore) { category = categories.includes("negative") ? "negative" : categories[categories.length - 1]; confidence = Math.min(95, 50 + (negScore / total) * 45); }
const __result__ = { category, confidence: Math.round(confidence), scores: { positive: posScore, negative: negScore, total }, wordCount: text.split(/\\s+/).length };`,
    inputSchema: '{"type":"object","required":["text"],"properties":{"text":{"type":"string","description":"Text to classify"},"categories":{"type":"array","description":"Classification categories"}}}',
    outputSchema: '{"type":"object","properties":{"category":{"type":"string"},"confidence":{"type":"number"},"scores":{"type":"object"},"wordCount":{"type":"number"}}}',
    exampleInput: '{"text":"This product is absolutely amazing and wonderful!"}',
    exampleOutput: '{"category":"positive","confidence":85,"scores":{"positive":2,"negative":0,"total":2},"wordCount":7}',
  },
  "extraction": {
    code: `const text = input.text || "";
const pattern = input.pattern || "email";
const patterns = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g,
  url: /https?:\\/\\/[^\\s<>"{}|\\\\^\\x60]+/g,
  phone: /\\+?[\\d][\\d\\-\\s().]{7,}\\d/g,
  number: /-?\\d+\\.?\\d*/g,
  hashtag: /#[a-zA-Z0-9_]+/g,
  mention: /@[a-zA-Z0-9_]+/g,
  date: /\\d{1,4}[-/.]\\d{1,2}[-/.]\\d{1,4}/g,
};
const regex = patterns[pattern] || new RegExp(pattern, "g");
const matches = text.match(regex) || [];
const unique = [...new Set(matches)];
const __result__ = { matches, unique, count: matches.length, uniqueCount: unique.length, pattern };`,
    inputSchema: '{"type":"object","required":["text"],"properties":{"text":{"type":"string","description":"Text to extract from"},"pattern":{"type":"string","description":"Pattern: email, url, phone, number, hashtag, mention, date, or custom regex"}}}',
    outputSchema: '{"type":"object","properties":{"matches":{"type":"array"},"unique":{"type":"array"},"count":{"type":"number"},"uniqueCount":{"type":"number"},"pattern":{"type":"string"}}}',
    exampleInput: '{"text":"Contact us at hello@build4.ai or support@build4.ai for help","pattern":"email"}',
    exampleOutput: '{"matches":["hello@build4.ai","support@build4.ai"],"unique":["hello@build4.ai","support@build4.ai"],"count":2,"uniqueCount":2,"pattern":"email"}',
  },
  "formatting": {
    code: `const data = input.data;
const format = input.format || "json";
let __result__;
if (format === "csv") {
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    const headers = Object.keys(data[0]);
    const rows = data.map(row => headers.map(h => String(row[h] ?? "")).join(","));
    __result__ = { formatted: [headers.join(","), ...rows].join("\\n"), format: "csv", rowCount: data.length };
  } else {
    __result__ = { formatted: String(data), format: "csv", rowCount: 1 };
  }
} else if (format === "markdown") {
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    const headers = Object.keys(data[0]);
    const headerRow = "| " + headers.join(" | ") + " |";
    const sepRow = "| " + headers.map(() => "---").join(" | ") + " |";
    const rows = data.map(row => "| " + headers.map(h => String(row[h] ?? "")).join(" | ") + " |");
    __result__ = { formatted: [headerRow, sepRow, ...rows].join("\\n"), format: "markdown", rowCount: data.length };
  } else {
    __result__ = { formatted: JSON.stringify(data, null, 2), format: "markdown", rowCount: 1 };
  }
} else {
  __result__ = { formatted: JSON.stringify(data, null, 2), format: "json", size: JSON.stringify(data).length };
}`,
    inputSchema: '{"type":"object","required":["data"],"properties":{"data":{"description":"Data to format"},"format":{"type":"string","description":"Output format: json, csv, markdown"}}}',
    outputSchema: '{"type":"object","properties":{"formatted":{"type":"string"},"format":{"type":"string"}}}',
    exampleInput: '{"data":[{"name":"Agent-1","score":95},{"name":"Agent-2","score":87}],"format":"csv"}',
    exampleOutput: '{"formatted":"name,score\\nAgent-1,95\\nAgent-2,87","format":"csv","rowCount":2}',
  },
  "math-compute": {
    code: `const operation = input.operation || "evaluate";
const values = input.values || [];
let __result__;
if (operation === "evaluate" && input.expression) {
  const expr = input.expression.replace(/[^0-9+\\-*/().\\s]/g, "");
  try { __result__ = { result: Function('"use strict"; return (' + expr + ')')(), expression: input.expression }; }
  catch { __result__ = { error: "Invalid expression", expression: input.expression }; }
} else if (operation === "statistics" && values.length > 0) {
  const nums = values.map(Number).filter(n => !isNaN(n));
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const sorted = [...nums].sort((a, b) => a - b);
  const median = nums.length % 2 === 0 ? (sorted[nums.length/2-1] + sorted[nums.length/2]) / 2 : sorted[Math.floor(nums.length/2)];
  const variance = nums.reduce((acc, n) => acc + Math.pow(n - mean, 2), 0) / nums.length;
  __result__ = { sum, mean, median, min: sorted[0], max: sorted[sorted.length-1], variance, stddev: Math.sqrt(variance), count: nums.length };
} else if (operation === "matrix" && input.a && input.b) {
  const a = input.a, b = input.b;
  if (a.length > 0 && b.length > 0 && a[0].length === b.length) {
    const result = a.map((row, i) => b[0].map((_, j) => row.reduce((sum, val, k) => sum + val * b[k][j], 0)));
    __result__ = { result, rows: result.length, cols: result[0].length };
  } else { __result__ = { error: "Matrix dimensions incompatible" }; }
} else {
  __result__ = { error: "Unsupported operation. Use: evaluate, statistics, matrix" };
}`,
    inputSchema: '{"type":"object","properties":{"operation":{"type":"string","description":"Operation: evaluate, statistics, matrix"},"expression":{"type":"string","description":"Math expression to evaluate"},"values":{"type":"array","description":"Array of numbers for statistics"},"a":{"type":"array","description":"First matrix"},"b":{"type":"array","description":"Second matrix"}}}',
    outputSchema: '{"type":"object","properties":{"result":{}}}',
    exampleInput: '{"operation":"statistics","values":[10,20,30,40,50]}',
    exampleOutput: '{"sum":150,"mean":30,"median":30,"min":10,"max":50,"variance":200,"stddev":14.14,"count":5}',
  },
  "crypto-data": {
    code: `const token = (input.token || "BNB").toLowerCase();
const action = input.action || "price";
const idMap = { bnb: "binancecoin", eth: "ethereum", btc: "bitcoin", sol: "solana", avax: "avalanche-2", matic: "matic-network", dot: "polkadot", link: "chainlink", uni: "uniswap", aave: "aave" };
const cgId = idMap[token] || token;

if (action === "detailed") {
  const res = await safeFetch("https://api.coingecko.com/api/v3/coins/" + cgId + "?localization=false&tickers=false&community_data=false&developer_data=false");
  if (res.ok && res.data) {
    const d = res.data;
    __result__ = { token: d.symbol?.toUpperCase(), name: d.name, price: d.market_data?.current_price?.usd, marketCap: d.market_data?.market_cap?.usd, volume24h: d.market_data?.total_volume?.usd, change24h: d.market_data?.price_change_percentage_24h, change7d: d.market_data?.price_change_percentage_7d, change30d: d.market_data?.price_change_percentage_30d, ath: d.market_data?.ath?.usd, athDate: d.market_data?.ath_date?.usd, circulatingSupply: d.market_data?.circulating_supply, totalSupply: d.market_data?.total_supply, rank: d.market_cap_rank, timestamp: __EXTERNAL_DATA__.timestampISO };
  } else {
    __result__ = { error: "Failed to fetch detailed data", token, apiStatus: res.status };
  }
} else if (action === "trending") {
  const res = await safeFetch("https://api.coingecko.com/api/v3/search/trending");
  if (res.ok && res.data?.coins) {
    __result__ = { trending: res.data.coins.slice(0, 10).map(c => ({ name: c.item.name, symbol: c.item.symbol, rank: c.item.market_cap_rank, score: c.item.score })), timestamp: __EXTERNAL_DATA__.timestampISO };
  } else { __result__ = { error: "Failed to fetch trending", apiStatus: res.status }; }
} else if (action === "fear_greed") {
  const res = await safeFetch("https://api.alternative.me/fng/?limit=7");
  if (res.ok && res.data?.data) {
    __result__ = { fearGreedIndex: res.data.data.map(d => ({ value: Number(d.value), label: d.value_classification, timestamp: new Date(d.timestamp * 1000).toISOString() })), timestamp: __EXTERNAL_DATA__.timestampISO };
  } else { __result__ = { error: "Failed to fetch fear/greed index" }; }
} else {
  const prices = __EXTERNAL_DATA__.cryptoPrices || {};
  const tokenData = prices[token.toUpperCase()];
  if (tokenData) {
    __result__ = { token: token.toUpperCase(), price: tokenData.usd, change24h: tokenData.change24h, gasPrice: __EXTERNAL_DATA__.gasPrice || null, timestamp: __EXTERNAL_DATA__.timestampISO };
  } else {
    const res = await safeFetch("https://api.coingecko.com/api/v3/simple/price?ids=" + cgId + "&vs_currencies=usd&include_24hr_change=true&include_market_cap=true");
    if (res.ok && res.data?.[cgId]) {
      __result__ = { token: token.toUpperCase(), price: res.data[cgId].usd, change24h: res.data[cgId].usd_24h_change, marketCap: res.data[cgId].usd_market_cap, timestamp: __EXTERNAL_DATA__.timestampISO };
    } else { __result__ = { error: "Token not found", token, timestamp: __EXTERNAL_DATA__.timestampISO }; }
  }
}`,
    inputSchema: '{"type":"object","properties":{"token":{"type":"string","description":"Token symbol: BNB, ETH, BTC, SOL, AVAX, etc."},"action":{"type":"string","description":"Action: price, detailed, trending, fear_greed"}}}',
    outputSchema: '{"type":"object","properties":{"token":{"type":"string"},"price":{"type":"number"},"change24h":{"type":"number"},"timestamp":{"type":"string"}}}',
    exampleInput: '{"token":"BNB","action":"detailed"}',
    exampleOutput: '{"token":"BNB","name":"BNB","price":600.5,"marketCap":92000000000,"volume24h":1500000000,"change24h":2.3,"rank":4,"timestamp":"2026-01-01T00:00:00.000Z"}',
  },
  "web-data": {
    code: `const dataType = input.type || "defi_tvl";

if (dataType === "defi_tvl") {
  const res = await safeFetch("https://api.llama.fi/v2/chains");
  if (res.ok && Array.isArray(res.data)) {
    const top = res.data.slice(0, 15).map(c => ({ chain: c.name, tvl: Math.round(c.tvl || 0), gecko_id: c.gecko_id }));
    __result__ = { topChainsByTVL: top, totalChains: res.data.length, timestamp: __EXTERNAL_DATA__.timestampISO };
  } else { __result__ = { error: "Failed to fetch DeFi TVL data" }; }
} else if (dataType === "dex_pairs") {
  const chain = input.chain || "bsc";
  const res = await safeFetch("https://api.dexscreener.com/latest/dex/search?q=" + (input.query || "BNB USDT"));
  if (res.ok && res.data?.pairs) {
    const pairs = res.data.pairs.slice(0, 10).map(p => ({ name: p.baseToken?.name, symbol: p.baseToken?.symbol, price: p.priceUsd, volume24h: p.volume?.h24, liquidity: p.liquidity?.usd, dex: p.dexId, chain: p.chainId, priceChange24h: p.priceChange?.h24 }));
    __result__ = { pairs, totalFound: res.data.pairs.length, query: input.query || "BNB USDT", timestamp: __EXTERNAL_DATA__.timestampISO };
  } else { __result__ = { error: "Failed to fetch DEX pairs" }; }
} else if (dataType === "yields") {
  const res = await safeFetch("https://yields.llama.fi/pools");
  if (res.ok && res.data?.data) {
    const top = res.data.data.filter(p => p.tvlUsd > 1000000).sort((a, b) => (b.apy || 0) - (a.apy || 0)).slice(0, 15).map(p => ({ pool: p.pool, project: p.project, chain: p.chain, symbol: p.symbol, tvl: Math.round(p.tvlUsd), apy: Number((p.apy || 0).toFixed(2)) }));
    __result__ = { topYields: top, timestamp: __EXTERNAL_DATA__.timestampISO };
  } else { __result__ = { error: "Failed to fetch yield data" }; }
} else if (dataType === "gas") {
  __result__ = { gasPrice: __EXTERNAL_DATA__.gasPrice || { info: "Gas data not available" }, timestamp: __EXTERNAL_DATA__.timestampISO };
} else if (dataType === "market_summary") {
  const prices = __EXTERNAL_DATA__.cryptoPrices || {};
  const tokens = Object.entries(prices);
  const gainers = tokens.filter(([,v]) => v.change24h > 0).sort((a,b) => b[1].change24h - a[1].change24h);
  const losers = tokens.filter(([,v]) => v.change24h <= 0).sort((a,b) => a[1].change24h - b[1].change24h);
  __result__ = { totalTokens: tokens.length, gainers: gainers.map(([k,v]) => ({ token: k, price: v.usd, change: v.change24h })), losers: losers.map(([k,v]) => ({ token: k, price: v.usd, change: v.change24h })), timestamp: __EXTERNAL_DATA__.timestampISO };
} else {
  __result__ = { available: ["defi_tvl", "dex_pairs", "yields", "gas", "market_summary"], timestamp: __EXTERNAL_DATA__.timestampISO };
}`,
    inputSchema: '{"type":"object","properties":{"type":{"type":"string","description":"Data type: defi_tvl, dex_pairs, yields, gas, market_summary"},"query":{"type":"string","description":"Search query for dex_pairs"},"chain":{"type":"string","description":"Chain for dex_pairs (bsc, ethereum, base)"}}}',
    outputSchema: '{"type":"object","properties":{"timestamp":{"type":"string"}}}',
    exampleInput: '{"type":"defi_tvl"}',
    exampleOutput: '{"topChainsByTVL":[{"chain":"Ethereum","tvl":50000000000}],"totalChains":200,"timestamp":"2026-01-01T00:00:00.000Z"}',
  },
};
