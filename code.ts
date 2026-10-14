// Uki AI UI Auditor — main thread.
// Walks the selection (or the page), runs the rule set, scores six categories out of 100,
// and applies one-click fixes. Everything here runs inside Figma; nothing leaves the file
// unless the user adds their own API key in Settings (the request is made from ui.html).

// ---- Types ---------------------------------------------------------------------------------------

type Severity = 'high' | 'medium' | 'low';
type Category = 'visual' | 'typography' | 'color' | 'layout' | 'navigation' | 'interaction';
type FixType = 'snap-grid' | 'rename' | 'enlarge-target' | 'fix-contrast' | 'min-text' | 'auto-layout';

interface Issue {
  id: string;
  rule: string;
  category: Category;
  severity: Severity;
  title: string;
  detail: string;
  nodeId: string | null;
  nodeName: string;
  fix?: FixType;
  noScore?: boolean;
}

interface Settings {
  grid: number;
  minText: number;
  minTarget: number;
  apiKey: string;
  model: string;
}

interface CategoryScore {
  key: Category;
  label: string;
  score: number;
  issues: number;
}

interface Report {
  scope: string;
  rootNames: string[];
  nodeCount: number;
  truncated: boolean;
  score: number;
  grade: string;
  a11y: number;
  categories: CategoryScore[];
  issues: Issue[];
  stats: {
    fonts: string[];
    sizes: number[];
    colors: string[];
    hidden: number;
    interactive: number;
    textLayers: number;
  };
  ranAt: number;
}

interface Col {
  r: number;
  g: number;
  b: number;
}

interface Walked {
  node: SceneNode;
  depth: number;
}

const DEFAULTS: Settings = { grid: 8, minText: 12, minTarget: 44, apiKey: '', model: 'claude-opus-5-5' };

const CATEGORY_LABELS: Record<Category, string> = {
  visual: 'Visual design',
  typography: 'Typography',
  color: 'Color scheme',
  layout: 'Layout',
  navigation: 'Navigation',
  interaction: 'Interaction',
};

const CATEGORY_WEIGHTS: Record<Category, number> = {
  color: 20,
  typography: 18,
  layout: 20,
  visual: 14,
  navigation: 13,
  interaction: 15,
};

const SEVERITY_COST: Record<Severity, number> = { high: 10, medium: 4, low: 1 };
const MAX_NODES = 6000;
const RULE_CAP = 40;

const DEFAULT_NAME =
  /^(Frame|Group|Rectangle|Ellipse|Line|Vector|Text|Polygon|Star|Image|Component|Instance|Union|Subtract|Intersect|Exclude|Slice|Section|Boolean group|Arrow)( \d+)?$/i;
const INTERACTIVE_NAME = /\b(button|btn|cta|tab|chip|toggle|switch|checkbox|radio|link|fab|icon[- ]?button|menu item|list item|card)\b/i;
const NAV_NAME = /\b(nav|navbar|header|tab ?bar|tabs|menu|back|home|breadcrumb|sidebar|bottom ?bar|app ?bar|toolbar)\b/i;

// ---- Settings ------------------------------------------------------------------------------------

let settings: Settings = Object.assign({}, DEFAULTS);
let lastRootIds: string[] = [];
let lastScope = 'selection';

async function loadSettings(): Promise<Settings> {
  const saved = (await figma.clientStorage.getAsync('uki-settings')) as Partial<Settings> | undefined;
  settings = Object.assign({}, DEFAULTS, saved || {});
  return settings;
}

async function saveSettings(next: Partial<Settings>) {
  settings = Object.assign({}, settings, next);
  await figma.clientStorage.setAsync('uki-settings', settings);
}

// ---- Colour maths --------------------------------------------------------------------------------

function toHex(c: Col): string {
  return (
    '#' +
    [c.r, c.g, c.b]
      .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

function luminance(c: Col): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrast(a: Col, b: Col): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blend(top: Col, alpha: number, under: Col): Col {
  return {
    r: top.r * alpha + under.r * (1 - alpha),
    g: top.g * alpha + under.g * (1 - alpha),
    b: top.b * alpha + under.b * (1 - alpha),
  };
}

function colorDistance(a: Col, b: Col): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) * 255;
}

/** First visible solid paint of a paint list, with its effective alpha. */
function solidOf(paints: ReadonlyArray<Paint> | PluginAPI['mixed'] | undefined): { color: Col; alpha: number } | null {
  if (!paints || paints === figma.mixed) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (p.visible === false) continue;
    if (p.type === 'SOLID') return { color: p.color, alpha: p.opacity === undefined ? 1 : p.opacity };
    // A gradient or image on top of a solid: treat as unknown so we don't report false contrast.
    return null;
  }
  return null;
}

function nodeOpacity(node: SceneNode): number {
  return 'opacity' in node ? node.opacity : 1;
}

/** The colour behind a node: nearest ancestor with a solid fill, composited, else the page. */
function backgroundBehind(node: SceneNode): Col | null {
  const layers: { color: Col; alpha: number }[] = [];
  let parent: BaseNode | null = node.parent;
  while (parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT') {
    const p = parent as SceneNode;
    if ('fills' in p) {
      const s = solidOf(p.fills);
      if (s) {
        layers.push({ color: s.color, alpha: s.alpha * nodeOpacity(p) });
        if (s.alpha * nodeOpacity(p) >= 0.999) break;
      } else if (p.fills !== figma.mixed && p.fills.some((f) => f.visible !== false && f.type !== 'SOLID')) {
        return null; // image or gradient behind: can't judge contrast reliably
      }
    }
    parent = p.parent;
  }
  let base: Col = { r: 1, g: 1, b: 1 };
  const pageBg = solidOf(figma.currentPage.backgrounds);
  if (pageBg) base = pageBg.color;
  for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i].color, layers[i].alpha, base);
  return base;
}

// ---- Walking the tree ----------------------------------------------------------------------------

function roots(scope: string): SceneNode[] {
  if (scope === 'page') return [...figma.currentPage.children];
  return [...figma.currentPage.selection];
}

async function walk(rootNodes: SceneNode[], onProgress: (n: number) => void): Promise<{ list: Walked[]; truncated: boolean; hidden: number }> {
  const list: Walked[] = [];
  let hidden = 0;
  let truncated = false;
  const stack: Walked[] = rootNodes.map((node) => ({ node, depth: 0 })).reverse();
  let since = 0;
  while (stack.length) {
    const item = stack.pop() as Walked;
    if (!item.node.visible) {
      hidden++;
      continue;
    }
    list.push(item);
    if (list.length >= MAX_NODES) {
      truncated = true;
      break;
    }
    if ('children' in item.node) {
      const kids = item.node.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], depth: item.depth + 1 });
    }
    if (++since >= 400) {
      since = 0;
      onProgress(list.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return { list, truncated, hidden };
}

// ---- Rule helpers --------------------------------------------------------------------------------

class Collector {
  issues: Issue[] = [];
  private counts: Record<string, number> = {};

  add(rule: string, category: Category, severity: Severity, node: SceneNode | null, title: string, detail: string, fix?: FixType) {
    const n = (this.counts[rule] = (this.counts[rule] || 0) + 1);
    if (n > RULE_CAP) {
      const last = this.issues.find((i) => i.rule === rule && i.noScore);
      if (last) {
        last.title = `${n - RULE_CAP} more ${title.toLowerCase()} issues not listed`;
        last.detail = 'Fix the listed ones and audit again to see the rest.';
      } else {
        this.issues.push({
          id: `${rule}:more`,
          rule,
          category,
          severity: 'low',
          title: `1 more ${title.toLowerCase()} issue not listed`,
          detail: 'Fix the listed ones and audit again to see the rest.',
          nodeId: null,
          nodeName: '',
          noScore: true,
        });
      }
      return;
    }
    this.issues.push({
      id: `${rule}:${node ? node.id : 'all'}`,
      rule,
      category,
      severity,
      title,
      detail,
      nodeId: node ? node.id : null,
      nodeName: node ? node.name : '',
      fix,
    });
  }
}

function isAutoLayout(node: BaseNode | null): boolean {
  return !!node && 'layoutMode' in node && (node as FrameNode).layoutMode !== 'NONE';
}

function isInteractive(node: SceneNode): boolean {
  if ('reactions' in node && node.reactions.length > 0) return true;
  if (INTERACTIVE_NAME.test(node.name)) return node.type !== 'TEXT';
  return false;
}

function hasTextInside(node: SceneNode): boolean {
  if (node.type === 'TEXT') return node.characters.trim().length > 0;
  if (!('children' in node)) return false;
  return node.children.some((c) => c.visible && hasTextInside(c));
}

function offGrid(v: number, grid: number): boolean {
  const m = Math.abs(v) % grid;
  return m > 0.51 && m < grid - 0.51;
}

function isBoldStyle(style: string): boolean {
  return /bold|black|heavy|extra ?bold|semi ?bold/i.test(style);
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- The audit -----------------------------------------------------------------------------------

async function audit(scope: string): Promise<Report | null> {
  const rootNodes = roots(scope);
  if (!rootNodes.length) return null;
  lastRootIds = rootNodes.map((n) => n.id);
  lastScope = scope;

  const post = (done: number) => figma.ui.postMessage({ type: 'progress', done });
  const { list, truncated, hidden } = await walk(rootNodes, post);
  const out = new Collector();
  const grid = settings.grid;

  const [textStyles, paintStyles, colorVars] = await Promise.all([
    figma.getLocalTextStylesAsync(),
    figma.getLocalPaintStylesAsync(),
    figma.variables.getLocalVariablesAsync('COLOR'),
  ]);
  const hasTextStyles = textStyles.length > 0;
  const hasColorTokens = paintStyles.length > 0 || colorVars.length > 0;

  const fonts = new Set<string>();
  const sizes = new Set<number>();
  const palette = new Map<string, Col>();
  const radii = new Set<number>();
  const strokeWeights = new Set<number>();
  const shadows = new Set<string>();
  let unstyledText = 0;
  let unboundFills = 0;
  let textLayers = 0;
  let interactiveCount = 0;
  let groupsWithChildren = 0;
  let anyPrototype = false;
  const interactiveNodes: SceneNode[] = [];
  const textSizesByRoot = new Map<string, number[]>();

  const rootOf = (w: Walked): string => {
    let n: BaseNode | null = w.node;
    while (n && n.parent && n.parent.type !== 'PAGE' && !lastRootIds.includes(n.id)) n = n.parent;
    return n ? n.id : w.node.id;
  };

  for (const w of list) {
    const node = w.node;
    const bounds = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;

    // -- Fills, strokes, effects, radii: feed the palette and consistency sets
    if ('fills' in node && node.fills !== figma.mixed) {
      for (const f of node.fills) {
        if (f.visible === false) continue;
        if (f.type === 'SOLID') palette.set(toHex(f.color), f.color);
      }
      const bound = (node.boundVariables && node.boundVariables.fills && node.boundVariables.fills.length > 0) || (('fillStyleId' in node) && node.fillStyleId !== '' && node.fillStyleId !== figma.mixed);
      if (hasColorTokens && !bound && node.fills.some((f) => f.visible !== false && f.type === 'SOLID')) unboundFills++;
    }
    if ('strokes' in node && node.strokes.some((s) => s.visible !== false)) {
      const sw = node.strokeWeight;
      if (typeof sw === 'number' && sw > 0) strokeWeights.add(Math.round(sw * 2) / 2);
    }
    if ('effects' in node) {
      for (const e of node.effects) {
        if (e.visible === false) continue;
        if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') shadows.add(`${e.type}:${e.radius}:${Math.round(e.offset.x)}:${Math.round(e.offset.y)}`);
      }
    }
    if ('cornerRadius' in node && typeof node.cornerRadius === 'number' && node.cornerRadius > 0) radii.add(Math.round(node.cornerRadius));

    // -- Naming, structure
    if (DEFAULT_NAME.test(node.name)) {
      out.add('default-name', 'navigation', 'low', node, 'Default layer name', `"${node.name}" tells teammates and assistive tech nothing. Name it by what it is.`, 'rename');
    }
    if (w.depth > 8) {
      out.add('deep-nesting', 'navigation', 'low', node, 'Deep nesting', `${w.depth} levels deep. Flatten groups or extract a component.`);
    }
    if (node.type === 'GROUP' && node.children.length > 0) groupsWithChildren++;

    // -- Interaction
    if (isInteractive(node)) {
      interactiveCount++;
      interactiveNodes.push(node);
      if ('reactions' in node && node.reactions.length > 0) anyPrototype = true;
      if (bounds) {
        const w2 = Math.round(bounds.width);
        const h2 = Math.round(bounds.height);
        const min = settings.minTarget;
        if (w2 < min || h2 < min) {
          const sev: Severity = Math.min(w2, h2) < 24 ? 'high' : 'medium';
          out.add('tap-target', 'interaction', sev, node, 'Small tap target', `${w2}×${h2}px. Interactive elements should be at least ${min}×${min}px to hit reliably.`, 'enlarge-target');
        }
      }
      if (!hasTextInside(node) && DEFAULT_NAME.test(node.name)) {
        out.add('unnamed-control', 'interaction', 'medium', node, 'Icon-only control without a name', 'There is no label inside and the layer name is generic. Name it so the intent survives handoff.', 'rename');
      }
    }

    // -- Text
    if (node.type === 'TEXT') {
      textLayers++;
      const len = node.characters.length;
      if (len === 0) continue;
      let segments: Array<{ fontSize: number; fontName: FontName; fills: readonly Paint[]; lineHeight: LineHeight; textStyleId: string }>;
      try {
        segments = node.getStyledTextSegments(['fontSize', 'fontName', 'fills', 'lineHeight', 'textStyleId']);
      } catch (_e) {
        continue;
      }
      const rootId = rootOf(w);
      const bg = backgroundBehind(node);
      let contrastReported = false;
      let smallReported = false;
      let lhReported = false;
      for (const seg of segments) {
        fonts.add(seg.fontName.family);
        const size = Math.round(seg.fontSize * 2) / 2;
        sizes.add(size);
        const arr = textSizesByRoot.get(rootId) || [];
        arr.push(size);
        textSizesByRoot.set(rootId, arr);
        if (hasTextStyles && !seg.textStyleId) unstyledText++;

        if (!smallReported && size < settings.minText) {
          smallReported = true;
          out.add('tiny-text', 'typography', size < 10 ? 'high' : 'medium', node, 'Text below minimum size', `${size}px. Body and label text should be at least ${settings.minText}px; captions rarely below 11px.`, 'min-text');
        }
        if (!lhReported && seg.lineHeight.unit === 'PERCENT' && seg.lineHeight.value < 110 && seg.lineHeight.value > 0) {
          lhReported = true;
          out.add('tight-leading', 'typography', 'low', node, 'Tight line height', `${Math.round(seg.lineHeight.value)}%. Body copy reads best between 130% and 160%.`);
        }
        if (!lhReported && seg.lineHeight.unit === 'PIXELS' && seg.lineHeight.value < seg.fontSize * 1.1) {
          lhReported = true;
          out.add('tight-leading', 'typography', 'low', node, 'Tight line height', `${Math.round(seg.lineHeight.value)}px on ${size}px type. Body copy reads best between 130% and 160%.`);
        }

        if (!contrastReported && bg) {
          const s = solidOf(seg.fills);
          if (s) {
            const fg = blend(s.color, s.alpha * nodeOpacity(node), bg);
            const ratio = contrast(fg, bg);
            const large = seg.fontSize >= 24 || (seg.fontSize >= 18.66 && isBoldStyle(seg.fontName.style));
            const need = large ? 3 : 4.5;
            if (ratio < need) {
              contrastReported = true;
              out.add(
                'contrast',
                'color',
                ratio < 3 ? 'high' : 'medium',
                node,
                'Low text contrast',
                `${ratio.toFixed(2)}:1 for ${toHex(fg)} on ${toHex(bg)}. WCAG AA needs ${need}:1 for ${large ? 'large' : 'this'} text.`,
                'fix-contrast',
              );
            }
          }
        }
      }
    }

    // -- Layout
    if (bounds && (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' || node.type === 'RECTANGLE' || node.type === 'COMPONENT_SET')) {
      const inAuto = isAutoLayout(node.parent) && ('layoutPositioning' in node ? node.layoutPositioning !== 'ABSOLUTE' : true);
      const wOff = offGrid(node.width, grid);
      const hOff = offGrid(node.height, grid);
      const xOff = !inAuto && w.depth > 0 && offGrid(node.x, grid);
      const yOff = !inAuto && w.depth > 0 && offGrid(node.y, grid);
      if (wOff || hOff || xOff || yOff) {
        const parts: string[] = [];
        if (wOff) parts.push(`width ${+node.width.toFixed(1)}`);
        if (hOff) parts.push(`height ${+node.height.toFixed(1)}`);
        if (xOff) parts.push(`x ${+node.x.toFixed(1)}`);
        if (yOff) parts.push(`y ${+node.y.toFixed(1)}`);
        out.add('off-grid', 'layout', wOff && hOff ? 'medium' : 'low', node, `Off the ${grid}pt grid`, `${parts.join(', ')}. Snapping keeps spacing rhythmic and handoff exact.`, 'snap-grid');
      }
      if ('layoutMode' in node) {
        if (node.layoutMode === 'NONE' && node.children.length >= 3) {
          const kids = node.children.filter((c) => c.visible);
          if (kids.length >= 3 && looksLinear(kids)) {
            out.add('no-auto-layout', 'layout', 'low', node, 'Stack without auto layout', `${kids.length} children arranged in a line but positioned by hand. Auto layout keeps them aligned when content changes.`, 'auto-layout');
          }
        } else if (node.layoutMode !== 'NONE') {
          const pads = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft, node.itemSpacing].filter((v) => typeof v === 'number' && v > 0);
          const off = pads.filter((v) => offGrid(v, grid));
          if (off.length) {
            out.add('off-grid-padding', 'layout', 'low', node, `Padding off the ${grid}pt grid`, `Values ${off.map((v) => +v.toFixed(1)).join(', ')}. Spacing tokens are easier to reuse on the grid.`, 'snap-grid');
          }
        }
        // Overflow: children outside a frame that doesn't clip
        if (!node.clipsContent) {
          for (const c of node.children) {
            if (!c.visible || !('absoluteBoundingBox' in c) || !c.absoluteBoundingBox) continue;
            const cb = c.absoluteBoundingBox;
            if (cb.x < bounds.x - 1 || cb.y < bounds.y - 1 || cb.x + cb.width > bounds.x + bounds.width + 1 || cb.y + cb.height > bounds.y + bounds.height + 1) {
              out.add('overflow', 'visual', 'medium', c, 'Overflows its parent', `"${c.name}" extends past "${node.name}", which doesn't clip. Resize the parent or clip content.`);
            }
          }
        }
        // Near-misses: siblings almost aligned in a hand-positioned frame
        if (node.layoutMode === 'NONE' && node.children.length >= 2) {
          const kids = node.children.filter((c) => c.visible);
          for (let i = 0; i < kids.length && i < 40; i++) {
            for (let j = i + 1; j < kids.length && j < 40; j++) {
              const dx = Math.abs(kids[i].x - kids[j].x);
              const dy = Math.abs(kids[i].y - kids[j].y);
              if ((dx > 0.5 && dx < 3) || (dy > 0.5 && dy < 3)) {
                out.add('near-aligned', 'layout', 'low', kids[j], 'Almost aligned', `"${kids[j].name}" is ${Math.max(dx, dy).toFixed(1)}px off from "${kids[i].name}". Snap them to the same edge.`);
                break;
              }
            }
          }
        }
      }
    }
  }

  // -- Aggregated rules

  const rootNode = rootNodes[0];
  if (fonts.size > 2) out.add('font-families', 'typography', fonts.size > 3 ? 'medium' : 'low', rootNode, 'Too many font families', `${fonts.size} families: ${[...fonts].join(', ')}. Two is plenty; one for display, one for body.`);
  if (sizes.size > 8) out.add('font-sizes', 'typography', sizes.size > 12 ? 'medium' : 'low', rootNode, 'Too many type sizes', `${sizes.size} distinct sizes. A scale of 6 to 8 steps covers most interfaces.`);
  if (hasTextStyles && unstyledText > 0) out.add('unstyled-text', 'typography', 'low', rootNode, 'Text not using text styles', `${unstyledText} text run${unstyledText === 1 ? '' : 's'} with no style, while this file has ${textStyles.length}. Apply styles so changes propagate.`);

  for (const [rootId, arr] of textSizesByRoot) {
    if (arr.length < 5) continue;
    const distinct = new Set(arr);
    const target = list.find((w) => w.node.id === rootId);
    const node = target ? target.node : rootNode;
    if (distinct.size === 1) {
      out.add('no-hierarchy', 'navigation', 'medium', node, 'No type hierarchy', `${arr.length} text layers, all ${arr[0]}px. Users scan by size: give headings and body distinct steps.`);
    } else {
      const max = Math.max(...arr);
      const share = arr.filter((v) => v === max).length / arr.length;
      if (share > 0.4 && arr.length >= 8) out.add('flat-hierarchy', 'navigation', 'low', node, 'Flat type hierarchy', `${Math.round(share * 100)}% of text is the largest size (${max}px). Reserve the top size for headings.`);
    }
  }

  const colors = [...palette.keys()];
  if (colors.length > 12) out.add('palette-sprawl', 'color', colors.length > 20 ? 'medium' : 'low', rootNode, 'Palette sprawl', `${colors.length} distinct solid colours. Most systems need 8 to 12, with tints handled by opacity or tokens.`);
  const dupes: string[] = [];
  const entries = [...palette.entries()];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const d = colorDistance(entries[i][1], entries[j][1]);
      if (d > 0 && d <= 12) dupes.push(`${entries[i][0]} ≈ ${entries[j][0]}`);
    }
  }
  if (dupes.length) out.add('near-duplicate-colors', 'color', 'low', rootNode, 'Near-duplicate colours', `${dupes.slice(0, 4).join('; ')}${dupes.length > 4 ? ` and ${dupes.length - 4} more` : ''}. Merge them into one token.`);
  if (hasColorTokens && unboundFills > 0) out.add('unbound-colors', 'color', unboundFills > 10 ? 'medium' : 'low', rootNode, 'Colours not bound to tokens', `${unboundFills} fill${unboundFills === 1 ? '' : 's'} use raw hex while this file has colour styles or variables. Bind them so themes stay in sync.`);

  if (radii.size > 4) out.add('radius-sprawl', 'visual', 'low', rootNode, 'Inconsistent corner radii', `${radii.size} different radii: ${[...radii].sort((a, b) => a - b).join(', ')}. Pick a small scale (for example 4, 8, 16, full).`);
  if (strokeWeights.size > 3) out.add('stroke-sprawl', 'visual', 'low', rootNode, 'Inconsistent stroke weights', `${strokeWeights.size} weights: ${[...strokeWeights].sort((a, b) => a - b).join(', ')}. One or two is usual.`);
  if (shadows.size > 3) out.add('shadow-sprawl', 'visual', 'low', rootNode, 'Inconsistent shadows', `${shadows.size} distinct shadow recipes. Define elevation levels and reuse them.`);
  if (groupsWithChildren > 3) out.add('groups', 'navigation', 'low', rootNode, 'Groups instead of frames', `${groupsWithChildren} groups. Frames support auto layout, constraints and clipping; groups don't.`);
  if (hidden > 0) out.add('hidden-layers', 'navigation', hidden > 10 ? 'medium' : 'low', rootNode, 'Hidden layers', `${hidden} hidden layer${hidden === 1 ? '' : 's'} skipped. Delete leftovers before handoff so developers don't build them.`);

  // Screens without a navigation landmark
  for (const r of rootNodes) {
    if (!('absoluteBoundingBox' in r) || !r.absoluteBoundingBox || !('children' in r)) continue;
    const b = r.absoluteBoundingBox;
    const screenLike = b.width >= 320 && b.width <= 1920 && b.height >= 480 && r.children.length >= 4;
    if (!screenLike) continue;
    const hasNav = list.some((w) => rootOf(w) === r.id && w.node.id !== r.id && NAV_NAME.test(w.node.name));
    if (!hasNav) out.add('no-nav', 'navigation', 'low', r, 'No navigation landmark', `"${r.name}" looks like a screen but nothing inside is named like a nav, header, tab bar or back control. Name the wayfinding so it's visible in the structure.`);
  }

  // Interactive neighbours too close, and prototype coverage
  const sortedI = interactiveNodes.filter((n) => 'absoluteBoundingBox' in n && n.absoluteBoundingBox);
  for (let i = 0; i < sortedI.length && i < 200; i++) {
    const a = (sortedI[i] as FrameNode).absoluteBoundingBox as Rect;
    for (let j = i + 1; j < sortedI.length && j < 200; j++) {
      if (sortedI[j].parent !== sortedI[i].parent) continue;
      const b = (sortedI[j] as FrameNode).absoluteBoundingBox as Rect;
      const gapX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
      const gapY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
      const gap = Math.max(gapX, gapY);
      if (gap >= 0 && gap < 8) {
        out.add('crowded-targets', 'interaction', 'low', sortedI[j], 'Crowded tap targets', `"${sortedI[j].name}" sits ${gap.toFixed(0)}px from "${sortedI[i].name}". Leave at least 8px between targets.`);
        break;
      }
    }
  }
  if (anyPrototype) {
    for (const n of interactiveNodes) {
      if ('reactions' in n && n.reactions.length === 0 && !NAV_NAME.test(n.name)) {
        out.add('no-prototype-link', 'interaction', 'low', n, 'Control without a prototype link', `This file has prototype links but "${n.name}" has none. Wire it or mark it as decorative.`);
      }
    }
  }

  // -- Scores
  const perCategory: Record<Category, number> = { visual: 0, typography: 0, color: 0, layout: 0, navigation: 0, interaction: 0 };
  const countCategory: Record<Category, number> = { visual: 0, typography: 0, color: 0, layout: 0, navigation: 0, interaction: 0 };
  for (const i of out.issues) {
    if (i.noScore) continue;
    perCategory[i.category] += SEVERITY_COST[i.severity];
    countCategory[i.category]++;
  }
  const categories: CategoryScore[] = (Object.keys(CATEGORY_LABELS) as Category[]).map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    score: Math.max(0, Math.round(100 - perCategory[key])),
    issues: countCategory[key],
  }));
  let weighted = 0;
  let totalW = 0;
  for (const c of categories) {
    weighted += c.score * CATEGORY_WEIGHTS[c.key];
    totalW += CATEGORY_WEIGHTS[c.key];
  }
  const score = Math.round(weighted / totalW);
  const a11yCost = out.issues.filter((i) => ['contrast', 'tap-target', 'tiny-text', 'unnamed-control', 'crowded-targets'].includes(i.rule)).reduce((s, i) => s + SEVERITY_COST[i.severity], 0);

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  out.issues.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));

  // The "Audit with Uki AI" relaunch button in the properties panel, with the last score as its hint.
  for (const r of rootNodes) {
    try {
      r.setRelaunchData({ audit: `Last score ${score}/100` });
    } catch (_e) {
      /* some node types can't carry relaunch data */
    }
  }

  return {
    scope,
    rootNames: rootNodes.map((n) => n.name),
    nodeCount: list.length,
    truncated,
    score,
    grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 55 ? 'D' : 'F',
    a11y: Math.max(0, 100 - a11yCost),
    categories,
    issues: out.issues,
    stats: {
      fonts: [...fonts],
      sizes: [...sizes].sort((a, b) => a - b),
      colors,
      hidden,
      interactive: interactiveCount,
      textLayers,
    },
    ranAt: Date.now(),
  };
}

/** True when children form a row or a column with no overlaps: a candidate for auto layout. */
function looksLinear(kids: readonly SceneNode[]): boolean {
  const byY = [...kids].sort((a, b) => a.y - b.y);
  let vertical = true;
  for (let i = 1; i < byY.length; i++) if (byY[i].y < byY[i - 1].y + byY[i - 1].height - 1) vertical = false;
  if (vertical) return true;
  const byX = [...kids].sort((a, b) => a.x - b.x);
  for (let i = 1; i < byX.length; i++) if (byX[i].x < byX[i - 1].x + byX[i - 1].width - 1) return false;
  return true;
}

// ---- Fixes ---------------------------------------------------------------------------------------

function snap(v: number, grid: number): number {
  return Math.max(grid, Math.round(v / grid) * grid);
}

async function loadFontsOf(node: TextNode) {
  const names = node.getRangeAllFontNames(0, node.characters.length);
  await Promise.all(names.map((f) => figma.loadFontAsync(f)));
}

function autoName(node: SceneNode): string {
  if (node.type === 'TEXT') {
    const t = node.characters.trim().replace(/\s+/g, ' ');
    return t.length > 28 ? t.slice(0, 27) + '…' : t || 'Text';
  }
  if (node.type === 'INSTANCE') return 'Instance of component';
  if ('fills' in node && node.fills !== figma.mixed && node.fills.some((f) => f.type === 'IMAGE')) return 'Image';
  if (node.type === 'ELLIPSE') return 'Circle';
  if (node.type === 'LINE') return 'Divider';
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') return 'Icon';
  if ('children' in node) {
    const text = node.children.find((c) => c.type === 'TEXT') as TextNode | undefined;
    if (text && text.characters.trim()) {
      const t = text.characters.trim().replace(/\s+/g, ' ');
      return (isInteractive(node) ? 'Button / ' : 'Container / ') + (t.length > 20 ? t.slice(0, 19) + '…' : t);
    }
    if (isAutoLayout(node)) return (node as FrameNode).layoutMode === 'VERTICAL' ? 'Stack' : 'Row';
    return node.children.length ? 'Container' : 'Spacer';
  }
  return 'Shape';
}

async function applyFix(nodeId: string, fix: FixType): Promise<string> {
  const node = (await figma.getNodeByIdAsync(nodeId)) as SceneNode | null;
  if (!node) throw new Error('That layer no longer exists.');
  const grid = settings.grid;

  switch (fix) {
    case 'rename': {
      node.name = autoName(node);
      return `Renamed to "${node.name}"`;
    }
    case 'snap-grid': {
      if (!('resize' in node)) throw new Error('This layer cannot be resized.');
      const n = node as FrameNode;
      if (isAutoLayout(n)) {
        n.paddingTop = Math.round(n.paddingTop / grid) * grid;
        n.paddingRight = Math.round(n.paddingRight / grid) * grid;
        n.paddingBottom = Math.round(n.paddingBottom / grid) * grid;
        n.paddingLeft = Math.round(n.paddingLeft / grid) * grid;
        n.itemSpacing = Math.round(n.itemSpacing / grid) * grid;
      }
      const inAuto = isAutoLayout(node.parent) && ('layoutPositioning' in node ? node.layoutPositioning !== 'ABSOLUTE' : true);
      const fixedW = !('layoutSizingHorizontal' in n) || n.layoutSizingHorizontal === 'FIXED';
      const fixedH = !('layoutSizingVertical' in n) || n.layoutSizingVertical === 'FIXED';
      const w = fixedW ? snap(n.width, grid) : n.width;
      const h = fixedH ? snap(n.height, grid) : n.height;
      if (w !== n.width || h !== n.height) n.resize(w, h);
      if (!inAuto && node.parent && node.parent.type !== 'PAGE') {
        n.x = Math.round(n.x / grid) * grid;
        n.y = Math.round(n.y / grid) * grid;
      }
      return `Snapped to ${grid}pt`;
    }
    case 'enlarge-target': {
      if (!('resize' in node)) throw new Error('This layer cannot be resized.');
      const n = node as FrameNode;
      const min = settings.minTarget;
      const w = Math.max(n.width, min);
      const h = Math.max(n.height, min);
      const dx = (w - n.width) / 2;
      const dy = (h - n.height) / 2;
      n.resize(w, h);
      const inAuto = isAutoLayout(node.parent) && ('layoutPositioning' in node ? node.layoutPositioning !== 'ABSOLUTE' : true);
      if (!inAuto) {
        n.x -= dx;
        n.y -= dy;
      }
      return `Resized to ${Math.round(w)}×${Math.round(h)}`;
    }
    case 'min-text': {
      if (node.type !== 'TEXT') throw new Error('Not a text layer.');
      await loadFontsOf(node);
      const segs = node.getStyledTextSegments(['fontSize']);
      for (const s of segs) if (s.fontSize < settings.minText) node.setRangeFontSize(s.start, s.end, settings.minText);
      return `Set to ${settings.minText}px`;
    }
    case 'fix-contrast': {
      if (node.type !== 'TEXT') throw new Error('Not a text layer.');
      const bg = backgroundBehind(node);
      if (!bg) throw new Error('Background is an image or gradient; adjust by hand.');
      const segs = node.getStyledTextSegments(['fills', 'fontSize', 'fontName']);
      const first = segs.find((s) => solidOf(s.fills));
      const start = first ? (solidOf(first.fills) as { color: Col }).color : { r: 0, g: 0, b: 0 };
      const toward: Col = luminance(bg) > 0.4 ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 };
      const large = first ? first.fontSize >= 24 || (first.fontSize >= 18.66 && isBoldStyle(first.fontName.style)) : false;
      const need = large ? 3 : 4.5;
      let best = start;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        best = blend(toward, t, start);
        if (contrast(best, bg) >= need) break;
      }
      node.fills = [{ type: 'SOLID', color: best, opacity: 1 }];
      return `Text set to ${toHex(best)} (${contrast(best, bg).toFixed(1)}:1)`;
    }
    case 'auto-layout': {
      if (!('layoutMode' in node)) throw new Error('Only frames can take auto layout.');
      const n = node as FrameNode;
      const kids = n.children.filter((c) => c.visible);
      if (kids.length < 2) throw new Error('Needs at least two visible children.');
      const byY = [...kids].sort((a, b) => a.y - b.y);
      let vertical = true;
      for (let i = 1; i < byY.length; i++) if (byY[i].y < byY[i - 1].y + byY[i - 1].height - 1) vertical = false;
      const ordered = vertical ? byY : [...kids].sort((a, b) => a.x - b.x);
      const gaps: number[] = [];
      for (let i = 1; i < ordered.length; i++) {
        const p = ordered[i - 1];
        gaps.push(vertical ? ordered[i].y - (p.y + p.height) : ordered[i].x - (p.x + p.width));
      }
      const padL = Math.max(0, Math.min(...kids.map((c) => c.x)));
      const padT = Math.max(0, Math.min(...kids.map((c) => c.y)));
      const padR = Math.max(0, n.width - Math.max(...kids.map((c) => c.x + c.width)));
      const padB = Math.max(0, n.height - Math.max(...kids.map((c) => c.y + c.height)));
      const w = n.width;
      const h = n.height;
      ordered.forEach((c, i) => n.insertChild(i, c));
      n.layoutMode = vertical ? 'VERTICAL' : 'HORIZONTAL';
      n.primaryAxisSizingMode = 'FIXED';
      n.counterAxisSizingMode = 'FIXED';
      n.itemSpacing = Math.max(0, Math.round(median(gaps)));
      n.paddingLeft = Math.round(padL);
      n.paddingTop = Math.round(padT);
      n.paddingRight = Math.round(padR);
      n.paddingBottom = Math.round(padB);
      n.resize(w, h);
      return `Auto layout: ${vertical ? 'vertical' : 'horizontal'}, gap ${n.itemSpacing}`;
    }
  }
}

// ---- Annotate on the canvas ----------------------------------------------------------------------

async function pickFont(style: 'Regular' | 'Semi Bold' | 'Bold'): Promise<FontName> {
  const candidates: FontName[] = [
    { family: 'Inter', style },
    { family: 'Inter', style: style === 'Semi Bold' ? 'Bold' : style },
    { family: 'Roboto', style: style === 'Semi Bold' ? 'Bold' : style },
    { family: 'Helvetica', style: style === 'Regular' ? 'Regular' : 'Bold' },
  ];
  for (const f of candidates) {
    try {
      await figma.loadFontAsync(f);
      return f;
    } catch (_e) {
      /* try the next one */
    }
  }
  throw new Error('No font available for the report. Install Inter or Roboto.');
}

async function annotate(report: Report) {
  const regular = await pickFont('Regular');
  const bold = await pickFont('Semi Bold');
  const ink = { r: 0.05, g: 0.06, b: 0.05 };
  const muted = { r: 0.42, g: 0.42, b: 0.52 };
  const accent = { r: 0.94, g: 0.78, b: 0.37 };
  const sevColor: Record<Severity, Col> = { high: { r: 0.93, g: 0.23, b: 0.32 }, medium: { r: 0.98, g: 0.62, b: 0.14 }, low: { r: 0.33, g: 0.6, b: 0.98 } };

  const frame = figma.createFrame();
  frame.name = `Uki AI audit · ${report.score}/100 · ${new Date(report.ranAt).toLocaleDateString()}`;
  frame.layoutMode = 'VERTICAL';
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'FIXED';
  frame.resize(380, 10);
  frame.paddingTop = frame.paddingBottom = 24;
  frame.paddingLeft = frame.paddingRight = 24;
  frame.itemSpacing = 10;
  frame.cornerRadius = 16;
  frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  frame.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.93 } }];
  frame.effects = [{ type: 'DROP_SHADOW', color: { r: 0.05, g: 0.05, b: 0.15, a: 0.14 }, offset: { x: 0, y: 12 }, radius: 32, spread: 0, visible: true, blendMode: 'NORMAL' }];

  const text = (chars: string, size: number, font: FontName, color: Col): TextNode => {
    const t = figma.createText();
    t.fontName = font;
    t.characters = chars;
    t.fontSize = size;
    t.fills = [{ type: 'SOLID', color }];
    return t;
  };
  /** Append to an auto-layout parent, then stretch it; sizing can only be set once it has a parent. */
  const addFill = (parent: FrameNode, t: TextNode): TextNode => {
    parent.appendChild(t);
    t.layoutSizingHorizontal = 'FILL';
    t.textAutoResize = 'HEIGHT';
    return t;
  };

  addFill(frame, text('UKI AI · UI AUDIT', 10, bold, muted));
  addFill(frame, text(`${report.score} / 100  ·  Grade ${report.grade}`, 28, bold, ink));
  addFill(frame, text(`${report.rootNames.join(', ')} · ${report.nodeCount} layers · accessibility ${report.a11y}/100`, 11, regular, muted));

  const bars = figma.createFrame();
  bars.name = 'Scores';
  bars.layoutMode = 'VERTICAL';
  bars.itemSpacing = 6;
  bars.fills = [];
  bars.primaryAxisSizingMode = 'AUTO';
  frame.appendChild(bars);
  bars.layoutSizingHorizontal = 'FILL';
  for (const c of report.categories) {
    const row = figma.createFrame();
    row.name = c.label;
    row.layoutMode = 'HORIZONTAL';
    row.counterAxisAlignItems = 'CENTER';
    row.itemSpacing = 10;
    row.fills = [];
    bars.appendChild(row);
    row.layoutSizingHorizontal = 'FILL';
    row.primaryAxisSizingMode = 'AUTO';
    const label = text(c.label, 11, regular, ink);
    row.appendChild(label);
    label.textAutoResize = 'HEIGHT';
    label.resize(110, label.height);
    const track = figma.createRectangle();
    track.resize(140, 6);
    track.cornerRadius = 3;
    track.fills = [{ type: 'SOLID', color: { r: 0.93, g: 0.93, b: 0.95 } }];
    const fill = figma.createRectangle();
    fill.resize(Math.max(6, (140 * c.score) / 100), 6);
    fill.cornerRadius = 3;
    fill.fills = [{ type: 'SOLID', color: c.score >= 80 ? { r: 0.2, g: 0.75, b: 0.45 } : c.score >= 60 ? accent : sevColor.high }];
    const trackWrap = figma.createFrame();
    trackWrap.fills = [];
    trackWrap.resize(140, 6);
    trackWrap.appendChild(track);
    trackWrap.appendChild(fill);
    row.appendChild(trackWrap);
    const num = text(String(c.score), 11, bold, ink);
    row.appendChild(num);
    num.textAutoResize = 'HEIGHT';
    num.resize(28, num.height);
    num.textAlignHorizontal = 'RIGHT';
  }

  const listed = report.issues.filter((i) => !i.noScore).slice(0, 12);
  if (listed.length) {
    addFill(frame, text('TOP ISSUES', 10, bold, muted));
    for (const i of listed) {
      const row = figma.createFrame();
      row.name = i.title;
      row.layoutMode = 'HORIZONTAL';
      row.itemSpacing = 8;
      row.fills = [];
      frame.appendChild(row);
      row.layoutSizingHorizontal = 'FILL';
      row.primaryAxisSizingMode = 'AUTO';
      const dot = figma.createEllipse();
      dot.resize(8, 8);
      dot.fills = [{ type: 'SOLID', color: sevColor[i.severity] }];
      row.appendChild(dot);
      const t = addFill(row, text(`${i.title}${i.nodeName ? ` · ${i.nodeName}` : ''}\n${i.detail}`, 11, regular, ink));
      t.setRangeFontName(0, i.title.length, bold);
      try {
        t.setRangeFills(i.title.length, t.characters.length, [{ type: 'SOLID', color: muted }]);
      } catch (_e) {
        /* fine */
      }
    }
    if (report.issues.length > listed.length) addFill(frame, text(`+ ${report.issues.length - listed.length} more in the plugin`, 10, regular, muted));
  } else {
    addFill(frame, text('No issues found. Ship it.', 12, bold, ink));
  }

  // Place it to the right of the audited layers.
  let x = 0;
  let y = 0;
  const first = (await figma.getNodeByIdAsync(lastRootIds[0])) as SceneNode | null;
  if (first && 'absoluteBoundingBox' in first && first.absoluteBoundingBox) {
    let maxRight = -Infinity;
    for (const id of lastRootIds) {
      const n = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
      if (n && 'absoluteBoundingBox' in n && n.absoluteBoundingBox) maxRight = Math.max(maxRight, n.absoluteBoundingBox.x + n.absoluteBoundingBox.width);
    }
    x = maxRight + 64;
    y = first.absoluteBoundingBox.y;
  } else {
    x = figma.viewport.center.x;
    y = figma.viewport.center.y;
  }
  frame.x = x;
  frame.y = y;
  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
}

// ---- Messages ------------------------------------------------------------------------------------

function selectionSummary() {
  const sel = figma.currentPage.selection;
  return {
    type: 'selection',
    count: sel.length,
    names: sel.slice(0, 3).map((n) => n.name),
    pageName: figma.currentPage.name,
  };
}

figma.showUI(__html__, { width: 440, height: 680, themeColors: true });

figma.on('selectionchange', () => figma.ui.postMessage(selectionSummary()));

let lastReport: Report | null = null;

async function runAudit(scope: string) {
  try {
    const report = await audit(scope);
    if (!report) {
      figma.ui.postMessage({ type: 'error', message: scope === 'page' ? 'This page is empty.' : 'Select a frame, a screen or a few layers first.' });
      return;
    }
    lastReport = report;
    figma.ui.postMessage({ type: 'result', report });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: (e as Error).message || 'The audit failed.' });
  }
}

figma.ui.onmessage = async (msg: { type: string; [k: string]: unknown }) => {
  switch (msg.type) {
    case 'init': {
      figma.ui.postMessage({ type: 'settings', settings: await loadSettings() });
      figma.ui.postMessage(selectionSummary());
      // Launched from the relaunch button: audit the selection straight away.
      if (figma.command === 'audit' && figma.currentPage.selection.length) {
        figma.ui.postMessage({ type: 'auto-run' });
        await runAudit('selection');
      }
      break;
    }
    case 'audit': {
      await runAudit(String(msg.scope || 'selection'));
      break;
    }
    case 'select': {
      const node = (await figma.getNodeByIdAsync(String(msg.nodeId))) as SceneNode | null;
      if (!node) {
        figma.notify('That layer no longer exists.');
        break;
      }
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
      break;
    }
    case 'fix': {
      try {
        const message = await applyFix(String(msg.nodeId), msg.fix as FixType);
        figma.notify(message);
        figma.ui.postMessage({ type: 'fixed', nodeId: msg.nodeId, fix: msg.fix, ok: true, message });
      } catch (e) {
        figma.notify((e as Error).message, { error: true });
        figma.ui.postMessage({ type: 'fixed', nodeId: msg.nodeId, fix: msg.fix, ok: false, message: (e as Error).message });
      }
      break;
    }
    case 'fix-all': {
      const items = msg.items as { nodeId: string; fix: FixType }[];
      let ok = 0;
      let failed = 0;
      for (const it of items) {
        try {
          await applyFix(it.nodeId, it.fix);
          ok++;
        } catch (_e) {
          failed++;
        }
      }
      figma.notify(`Fixed ${ok}${failed ? `, ${failed} skipped` : ''}`);
      figma.ui.postMessage({ type: 'fixed-all', ok, failed });
      break;
    }
    case 'reaudit': {
      if (!lastRootIds.length) break;
      const nodes: SceneNode[] = [];
      for (const id of lastRootIds) {
        const n = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
        if (n) nodes.push(n);
      }
      if (lastScope === 'page') {
        await runAudit('page');
      } else if (nodes.length) {
        figma.currentPage.selection = nodes;
        await runAudit('selection');
      }
      break;
    }
    case 'annotate': {
      if (!lastReport) break;
      try {
        await annotate(lastReport);
        figma.notify('Audit card added next to your design');
      } catch (e) {
        figma.notify((e as Error).message, { error: true });
      }
      break;
    }
    case 'save-settings': {
      await saveSettings(msg.settings as Partial<Settings>);
      figma.ui.postMessage({ type: 'settings', settings });
      break;
    }
    case 'resize': {
      figma.ui.resize(Math.max(360, Number(msg.width)), Math.max(480, Number(msg.height)));
      break;
    }
    case 'notify': {
      figma.notify(String(msg.message));
      break;
    }
    case 'close': {
      figma.closePlugin();
      break;
    }
  }
};
