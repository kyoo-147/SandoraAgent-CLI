import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { createSandoraSession } from "../runtime/create-session.mjs";
import { createCodingTools } from "../tools/coding-tools.mjs";
import { browserTools } from "../browser/tools.mjs";
import { createGitTools } from "../git/tools.mjs";
import { createInitialState, reduceAgentEvent, cleanupOutput } from "../runtime/event-reducer.mjs";

const cwd = process.cwd();
const logoPath = fileURLToPath(new URL("../../assets/sandora-logo.png", import.meta.url));
const CSI = "\x1b[";
const RESET = `${CSI}0m`;
const SYNC_START = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;
const colors = {
  acid: `${CSI}38;2;217;255;87m`,
  ink: `${CSI}38;2;244;247;236m`,
  body: `${CSI}38;2;215;224;215m`,
  muted: `${CSI}38;2;156;169;159m`,
  dim: `${CSI}38;2;97;114;105m`,
  line: `${CSI}38;2;73;96;87m`,
  panel: `${CSI}48;2;10;29;22m`,
  error: `${CSI}38;2;255;137;125m`,
};

const DISPLAY_MODEL = "SANDORA 2.5 9B COMPUTER USE";
const DISPLAY_CONTEXT_WINDOW = 261_000;
const ASCII_LOGO = [
  "        ╭──╮        ",
  "    ╭───╯  ╰───╮    ",
  "   ╱   ╲    ╱   ╲   ",
  "   ╲    ╲╱╲╱    ╱   ",
  "    ╰───╮  ╭───╯    ",
  "        ╰──╯        ",
];
let logoLines = [];
let logoWidth = 0;
let headerLogoLines = [];
let headerLogoWidth = 0;
const ground = [3, 18, 13];

function rgbaPixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  const alpha = image.data[i + 3] / 255;
  return {
    r: Math.round(image.data[i] * alpha + ground[0] * (1 - alpha)),
    g: Math.round(image.data[i + 1] * alpha + ground[1] * (1 - alpha)),
    b: Math.round(image.data[i + 2] * alpha + ground[2] * (1 - alpha)),
    alpha,
  };
}

function buildLogo(targetWidth) {
  let image;
  try { image = PNG.sync.read(fs.readFileSync(logoPath)); }
  catch { return ASCII_LOGO; }
  let left = image.width, top = image.height, right = 0, bottom = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.data[(y * image.width + x) * 4 + 3] > 12) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return [];
  const sourceWidth = right - left + 1;
  const sourceHeight = bottom - top + 1;
  const outWidth = Math.max(12, Math.min(targetWidth, sourceWidth));
  // Preserve the source aspect ratio. Do not stretch the mark to fill the
  // header: the right-hand loop is part of the identity and must stay intact.
  // Preserve the cropped artwork's native proportions. Half-block rendering
  // already packs two vertical samples into each terminal row; applying a
  // second correction here would flatten the mark horizontally.
  const outHeight = Math.max(2, Math.round(sourceHeight * outWidth / sourceWidth));
  const pixel = (x, y) => {
    const sourceX = left + (x + 0.5) * sourceWidth / outWidth - 0.5;
    const sourceY = top + (y + 0.5) * sourceHeight / outHeight - 0.5;
    const x0 = Math.max(left, Math.floor(sourceX));
    const y0 = Math.max(top, Math.floor(sourceY));
    const x1 = Math.min(right, x0 + 1);
    const y1 = Math.min(bottom, y0 + 1);
    const fx = Math.max(0, Math.min(1, sourceX - x0));
    const fy = Math.max(0, Math.min(1, sourceY - y0));
    const a = rgbaPixel(image, x0, y0);
    const b = rgbaPixel(image, x1, y0);
    const c = rgbaPixel(image, x0, y1);
    const d = rgbaPixel(image, x1, y1);
    const mix = (key) => (a[key] * (1 - fx) + b[key] * fx) * (1 - fy) + (c[key] * (1 - fx) + d[key] * fx) * fy;
    return { r: Math.round(mix("r")), g: Math.round(mix("g")), b: Math.round(mix("b")), alpha: mix("alpha") };
  };
  const rows = [];
  for (let y = 0; y < outHeight; y += 2) {
    let row = "";
    for (let x = 0; x < outWidth; x++) {
      const upper = pixel(x, y);
      const lower = y + 1 < outHeight ? pixel(x, y + 1) : { ...upper, alpha: 0 };
      // Reset the ANSI background before every transparent cell. A plain
      // space would inherit the previous pixel's background and smear the
      // last blue sample into a rectangular block on the right.
      if (upper.alpha < 0.03 && lower.alpha < 0.03) { row += `${CSI}49m `; continue; }
      const fg = upper.alpha >= 0.03 ? upper : lower;
      const bg = upper.alpha >= 0.03 && lower.alpha >= 0.03
        ? lower
        : { r: ground[0], g: ground[1], b: ground[2] };
      const glyph = upper.alpha >= 0.03 ? "▀" : "▄";
      row += `${CSI}38;2;${fg.r};${fg.g};${fg.b}m${CSI}48;2;${bg.r};${bg.g};${bg.b}m${glyph}`;
    }
    rows.push(`${row}${RESET}`);
  }
  return rows;
}
const COMMANDS = [
  ["/help", "show commands and shortcuts"],
  ["/clear", "clear this conversation view"],
  ["/ask", "ask Sandora directly"],
  ["/explain", "explain a topic simply"],
  ["/compare", "compare two ideas or options"],
  ["/evidence", "separate evidence from claims"],
  ["/brief", "turn a topic into a research brief"],
  ["/challenge", "stress-test an idea"],
  ["/summarize", "summarize the given text"],
  ["/translate", "translate while preserving meaning"],
  ["/tools", "show available capabilities"],
  ["/status", "show current session status"],
  ["/session", "show session information"],
  ["/quit", "exit Sandora Agent"],
];

const COMMAND_PROMPTS = {
  "/ask": "Answer the user's question directly.",
  "/explain": "Explain the following topic simply, using an everyday analogy first, then the precise explanation.",
  "/compare": "Compare the following options in a compact table, then give trade-offs and a conditional recommendation.",
  "/evidence": "Analyze the following claim. Separate verified facts, inference, assumptions, unknowns, and what evidence would resolve the uncertainty.",
  "/brief": "Turn the following topic into a concise research brief with question, scope, assumptions, sources needed, risks, and next step.",
  "/challenge": "Adversarially stress-test the following idea. Give the strongest objection, hidden assumptions, leakage or cost traps, and one decisive experiment.",
  "/summarize": "Summarize the following text faithfully. Preserve uncertainty and do not invent missing details.",
  "/translate": "Translate the following text. Preserve meaning, tone, names, formatting intent, and uncertainty; mention ambiguities briefly.",
};

function stripMarkdown(text) {
  return String(text)
    .replace(/^\s*```.*$/gm, "")
    .replace(/^\s*([-*_]){3,}\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!`)`([^`]+)`(?!`)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*>\s?/gm, "│ ");
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

const systemPrompt = [
  "You are Sandora Agent, an autonomous coding and research agent for Navin Research.",
  "Work proactively inside the selected workspace. Use workspace_list, workspace_read, workspace_search, workspace_write, workspace_edit, workspace_delete, and workspace_shell to understand requests, inspect code, implement changes, run builds/tests, diagnose failures, repair them, and verify again instead of stopping at the first error.",
  "Use delegate_subagents for independent read-only exploration, debugging, review, testing, or research when parallel work is useful. Use delegate_writable_worker only for genuinely independent implementation tasks; each writer receives an isolated recoverable Git worktree. Inspect and validate worker output before requesting integration. You remain responsible for planning, synthesis, integration, and final verification.",
  "Use the dedicated Git and GitHub tools to inspect status/diff/history, create feature branches, commit only intended paths, push, create/review PRs, and merge only when requested or clearly permitted after checks pass. Never force-push main.",
  "Do not access unrelated paths, expose credentials, run destructive system commands, or overwrite unrelated user changes. Review the final diff and status before delivery.",
  "Explain what you are doing and report verified facts, inference, assumptions, unknowns, failures, and remaining risks. Answer in the user's language.",
].join(" ");

const session = await createSandoraSession({ cwd, customTools: [...createCodingTools(), ...createGitTools(), ...browserTools], systemPrompt });

let state = createInitialState();
state.messages = session.getDisplayMessages?.() || [];
let shutdownAfterRun = false;
let streamCommandBuffer = "";
let previousFrame = [];
let previousSize = "";
let activityTimer;
function dispatch(event) {
  state = reduceAgentEvent(state, event);
  render();
}
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function width() {
  return Math.max(60, process.stdout.columns || 100);
}

function visibleLength(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").length;
}

function fit(text, size) {
  if (visibleLength(text) <= size) return pad(text, size);
  const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
  let output = "";
  let visible = 0;
  for (let i = 0; i < text.length && visible < size; ) {
    ansi.lastIndex = i;
    const match = ansi.exec(text);
    if (match) {
      output += match[0];
      i = ansi.lastIndex;
      continue;
    }
    output += text[i++];
    visible++;
  }
  return `${output}${RESET}${" ".repeat(Math.max(0, size - visible))}`;
}

function pad(text, size) {
  return text + " ".repeat(Math.max(0, size - visibleLength(text)));
}

function wrap(text, max) {
  const result = [];
  for (const paragraph of String(text).split("\n")) {
    if (!paragraph) {
      result.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > max) {
      let cut = remaining.lastIndexOf(" ", max);
      if (cut < Math.floor(max * 0.55)) cut = max;
      result.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    result.push(remaining);
  }
  return result;
}

function layoutMode() {
  const w = width();
  return w < 80 ? "COMPACT" : w < 120 ? "BALANCED" : "WIDE";
}

function rule(char = "─") {
  return `${colors.line}${char.repeat(width())}${RESET}`;
}

function boxLine(text = "") {
  const inner = width() - 4;
  return `${colors.line}│${RESET} ${fit(text, inner)} ${colors.line}│${RESET}`;
}

function suggestions() {
  if (state.streaming || !state.input.startsWith("/")) return [];
  const query = state.input.toLowerCase();
  return COMMANDS.filter(([command]) => command.startsWith(query));
}

function setActivity(status, activity) {
  state.status = status;
  state.activity = activity;
  render();
}

function startActivityTicker() {
  clearInterval(activityTimer);
  activityTimer = setInterval(() => {
    state.spinnerIndex = (state.spinnerIndex + 1) % spinnerFrames.length;
    render();
  }, 120);
}

function stopActivityTicker() {
  clearInterval(activityTimer);
  activityTimer = undefined;
}

function render() {
  const w = width();
  const inner = w - 4;
  const lines = [];
  lines.push(`${colors.line}╭${"─".repeat(w - 2)}╮${RESET}`);
  // Sixteen horizontal samples give the smaller right loop enough detail.
  // The header grows by one row when needed rather than flattening the image.
  const desiredHeaderLogoWidth = 16;
  if (headerLogoWidth !== desiredHeaderLogoWidth) {
    headerLogoLines = buildLogo(desiredHeaderLogoWidth);
    headerLogoWidth = desiredHeaderLogoWidth;
  }
  const headerInfo = [
    `${colors.acid}NAVIN SANDORA${RESET}  ${colors.muted}autonomous coding & research agent${RESET}`,
    `${colors.dim}workspace${RESET} ${colors.ink}${cwd}${RESET}`,
    `${colors.dim}session  ${RESET}${colors.muted}${session.sessionId.slice(0, 12)}${RESET}`,
    `${colors.dim}model    ${RESET}${colors.acid}${DISPLAY_MODEL}${RESET}  ${colors.dim}layout${RESET} ${colors.muted}${layoutMode()}${RESET}`,
  ];
  for (let i = 0; i < Math.max(headerInfo.length, headerLogoLines.length); i++) {
    const logo = headerLogoLines[i] || " ".repeat(headerLogoWidth);
    lines.push(boxLine(`${logo}  ${headerInfo[i] || ""}`));
  }
  lines.push(`${colors.line}╰${"─".repeat(w - 2)}╯${RESET}`);
  lines.push("");

  if (state.messages.length === 0) {
    lines.push(`${colors.acid}✦  WELCOME TO SANDORA${RESET}`);
    lines.push(`${colors.body}Inspect, build, test, and ship from one terminal.${RESET}`);
    lines.push("");
    lines.push(`${colors.dim}Try asking:${RESET}`);
    lines.push(`  ${colors.muted}› Inspect this repository and explain its architecture${RESET}`);
    lines.push(`  ${colors.muted}› Find why the tests fail, repair them, and verify the fix${RESET}`);
    lines.push(`  ${colors.muted}› Research options in parallel and recommend the next step${RESET}`);
  }

  for (const message of state.messages) {
    const label = message.role === "user" ? `${colors.acid}YOU${RESET}` : `${colors.acid}SANDORA AGENT${RESET}`;
    lines.push(`${label} ${colors.dim}·${RESET}`);
    for (const row of wrap(stripMarkdown(message.text || (state.streaming ? "…" : "")), inner)) {
      lines.push(`  ${message.role === "user" ? colors.ink : colors.body}${row}${RESET}`);
    }
    lines.push("");
  }

  if (state.streaming && state.activity) {
    const spinner = spinnerFrames[state.spinnerIndex];
    lines.push(`${colors.acid}${spinner} ${state.activity}${RESET}`);
    lines.push("");
  }

  if (state.error) {
    lines.push(`${colors.error}ERROR${RESET} ${colors.muted}${state.error}${RESET}`);
    lines.push("");
  }

  const inputLabel = state.streaming ? `${colors.acid}● ${state.status}${RESET}` : `${colors.acid}MESSAGE${RESET}`;
  const inputStart = lines.length;
  lines.push(rule());
  lines.push(`${inputLabel} ${colors.dim}(${state.streaming ? "Ctrl+C to stop" : "Enter to send"})${RESET}`);
  const inputText = state.input || (state.streaming ? "" : "Type your question here...");
  const inputColor = state.input ? colors.ink : colors.dim;
  const inputRows = wrap(inputText, inner - 2).slice(-3);
  if (state.input && state.input.length <= inner - 2 && !state.streaming) {
    const before = state.input.slice(0, state.cursor);
    const after = state.input.slice(state.cursor);
    lines.push(`${colors.line}│${RESET} ${inputColor}${before}${after}${RESET}`);
  } else {
    for (const row of inputRows) lines.push(`${colors.line}│${RESET} ${inputColor}${row}${RESET}`);
  }
  const matches = suggestions();

  if (matches.length) {
    lines.push("");
    lines.push(`${colors.acid}COMMANDS${RESET} ${colors.dim}· tab complete · ↑↓ select${RESET}`);
    matches.forEach(([command, description], index) => {
      const marker = index === state.commandIndex ? `${colors.acid}›${RESET}` : " ";
      lines.push(` ${marker} ${colors.ink}${command}${RESET}  ${colors.muted}${description}${RESET}`);
    });
  }
  lines.push(`${colors.line}╰${"─".repeat(w - 2)}╯${RESET}`);
  const u = state.usage;
  const cacheHit = u.input + u.cacheRead > 0 ? `${((u.cacheRead / (u.input + u.cacheRead)) * 100).toFixed(1)}%` : "—";
  const contextUsage = session.getContextUsage();
  const context = contextUsage?.tokens != null
    ? `${((contextUsage.tokens / DISPLAY_CONTEXT_WINDOW) * 100).toFixed(1)}%/${compactNumber(DISPLAY_CONTEXT_WINDOW)}`
    : `0.0%/${compactNumber(DISPLAY_CONTEXT_WINDOW)}`;
  const elapsed = state.responseStartedAt ? Math.max(0.1, (Date.now() - state.responseStartedAt) / 1000) : 0;
  const tps = elapsed && u.output ? `TPS: ${(u.output / elapsed).toFixed(1)} tok/s` : "TPS: —";
  lines.push(`${colors.dim}↑${compactNumber(u.input)} ↓${compactNumber(u.output)} R${compactNumber(u.cacheRead)} CH${cacheHit} $${u.cost.toFixed(3)} · CTX ${context}${RESET}`);
  lines.push(`${colors.dim}${DISPLAY_MODEL}                                      ${tps}${RESET}`);
  lines.push(`${colors.dim}Ctrl+L clear  ·  /help commands  ·  /quit exit${RESET}`);
  const terminalRows = process.stdout.rows || 30;
  const paddingRows = Math.max(0, terminalRows - 1 - lines.length);
  while (lines.length < terminalRows - 1) lines.splice(inputStart, 0, "");
  const size = `${w}x${terminalRows}`;
  let output = "";
  if (size !== previousSize) {
    output += `${CSI}2J${CSI}H`;
    previousFrame = [];
    previousSize = size;
  }
  const total = Math.max(previousFrame.length, lines.length);
  for (let i = 0; i < total; i++) {
    const next = lines[i] || "";
    if (next !== previousFrame[i]) output += `${CSI}${i + 1};1H${CSI}2K${next}`;
  }
  const cursorVisible = Boolean(state.input) && !state.streaming && state.input.length <= inner - 2;
  const cursorRow = inputStart + paddingRows + 3;
  const cursorColumn = 3 + visibleLength(state.input.slice(0, state.cursor));
  const cursor = cursorVisible
    ? `${CSI}${cursorRow};${cursorColumn}H${CSI}?25h`
    : `${CSI}?25l`;
  process.stdout.write(`${SYNC_START}${output}${cursor}${SYNC_END}`);
  previousFrame = lines;
}

function submit(text) {
  if (!text) return;
  if (text === "/quit" || text === "/exit") {
    if (state.streaming) { shutdownAfterRun = true; requestAbort(); return; }
    return shutdown();
  }
  if (state.streaming) return;
  const displayText = text;
  if (text === "/tools") {
    state.messages.push({ role: "assistant", text: "Available capabilities\n• Read and search repository files\n• Create, edit, and delete files\n• Run bounded shell commands, builds, and tests\n• Inspect failures and repair them\n• Inspect Git status, diff, history, branches, commits, pushes, and pull requests\n• Delegate up to four independent read-only subagents in parallel\n• Run explicitly named writable workers in isolated recoverable Git worktrees\n• Use structured browser automation when a Chromium/CDP backend is available\n\nMerge capabilities require explicit runtime authority. Direct desktop computer use fails closed until a supported adapter is configured." });
    state.input = "";
    state.cursor = 0;
    render();
    return;
  }
  const commandName = text.split(/\s+/, 1)[0].toLowerCase();
  if (COMMAND_PROMPTS[commandName]) {
    const argument = text.slice(commandName.length).trim();
    if (!argument) {
      state.messages.push({ role: "assistant", text: `Usage: ${commandName} <your topic or text>` });
      state.input = "";
      state.cursor = 0;
      render();
      return;
    }
    text = `${COMMAND_PROMPTS[commandName]}\n\nUser input:\n${argument}`;
  }
  if (text === "/status") {
    state.messages.push({ role: "assistant", text: `Status: ${state.status}\nModel: ${DISPLAY_MODEL}\nCapability: autonomous workspace coding/research\nTools: filesystem, search, shell, Git, parallel read-only subagents\nRuntime: ${session.runtime || "unknown"}\nEngine: ${session.model?.id || "auto"}` });
    state.input = "";
    state.cursor = 0;
    render();
    return;
  }
  if (text === "/session") {
    state.messages.push({ role: "assistant", text: `Session ${session.sessionId}\nWorkspace ${cwd}` });
    state.input = "";
    state.cursor = 0;
    render();
    return;
  }
  if (text === "/help") {
    state.messages.push({ role: "assistant", text: "Commands: /help  /tools  /status  /session  /clear  /quit\nPrompt helpers: /ask  /explain  /compare  /evidence  /brief  /challenge  /summarize  /translate\nEnter sends a message. Ctrl+C stops an active response; press it while idle to exit." });
    state.input = "";
    render();
    return;
  }
  if (text === "/clear") {
    state.messages = [];
    state.input = "";
    state.error = "";
    render();
    return;
  }

  state.messages.push({ role: "user", text: displayText });
  state.input = "";
  state.error = "";
  state.streaming = true;
  state.status = "THINKING";
  state.abortRequested = false;
  state.activity = "Opening model stream";
  state.responseStartedAt = 0;
  startActivityTicker();
  render();
  void session.prompt(text).catch(() => { /* run.error/run.abort arrives through the shared session lifecycle */ }).finally(() => {
    stopActivityTicker();
    state = cleanupOutput(state);
    render();
    if (shutdownAfterRun) shutdown();
  });
}

const runScopedEvents = new Set(["agent.start", "agent.end", "message.start", "message.end", "text.delta", "thinking.delta", "tool.start", "tool.update", "tool.end", "turn.start", "turn.end", "retry.start", "retry.end"]);
session.subscribe((event) => {
  if (!state.streaming && runScopedEvents.has(event?.type)) return;
  dispatch(event);
});

function shutdown() {
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  session.dispose();
  process.stdout.write(`${CSI}?25h${CSI}?1049l${RESET}\n`);
  process.exit(0);
}
function requestAbort() {
  if (!state.streaming || state.abortRequested) return;
  state.abortRequested = true;
  state.status = "ABORTING";
  state.activity = "Stopping the active run";
  render();
  void session.abort().catch((error) => {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  });
}

process.stdout.write(`${CSI}?1049h${CSI}?25l`);
process.stdout.on("resize", () => {
  previousSize = "";
  render();
});
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();
function handleInput(data) {
  const characters = [...data];
  if (characters.length > 1 && !data.startsWith("\x1b")) {
    for (const character of characters) handleInput(character);
    return;
  }
  if (data === "\u0003") {
    if (state.streaming) {
      requestAbort();
    } else shutdown();
    return;
  }
  if (state.streaming && !data.startsWith("\x1b")) {
    if (data === "\r" || data === "\n") {
      const command = streamCommandBuffer;
      streamCommandBuffer = "";
      if (command === "/quit" || command === "/exit") submit(command);
      return;
    }
    const clean = data.replace(/[^A-Za-z/]/g, "").toLowerCase();
    const candidate = `${streamCommandBuffer}${clean}`;
    streamCommandBuffer = ["/quit", "/exit"].some(command => command.startsWith(candidate)) ? candidate : "";
    return;
  }
  if (data === "\u000c") {
    state.messages = [];
    state.input = "";
    state.error = "";
    render();
    return;
  }
  if (data === "\r" || data === "\n") {
    const text = state.input.trim();
    state.input = "";
    submit(text);
    return;
  }
  if (data === "\t" && suggestions().length && !state.streaming) {
    const [command] = suggestions()[state.commandIndex] || suggestions()[0];
    state.input = `${command} `;
    state.cursor = state.input.length;
    render();
    return;
  }
  if (data === "\x1b[A" && suggestions().length) {
    state.commandIndex = (state.commandIndex - 1 + suggestions().length) % suggestions().length;
    render();
    return;
  }
  if (data === "\x1b[B" && suggestions().length) {
    state.commandIndex = (state.commandIndex + 1) % suggestions().length;
    render();
    return;
  }
  if (data === "\x1b[D") {
    state.cursor = Math.max(0, state.cursor - 1);
    render();
    return;
  }
  if (data === "\x1b[C") {
    state.cursor = Math.min(state.input.length, state.cursor + 1);
    render();
    return;
  }
  if (data === "\u007f" || data === "\b") {
    if (state.cursor > 0) {
      state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
      state.cursor -= 1;
    }
    render();
    return;
  }
  if (!data.startsWith("\x1b") && !state.streaming) {
    const clean = data.replace(/[\x00-\x1f\x7f]/g, "");
    state.input = state.input.slice(0, state.cursor) + clean + state.input.slice(state.cursor);
    state.cursor += clean.length;
    render();
  }
}
process.stdin.on("data", handleInput);
process.on("SIGINT", () => state.streaming ? requestAbort() : shutdown());
process.on("exit", () => process.stdout.write(`${CSI}?25h${CSI}?1049l${RESET}`));

render();
