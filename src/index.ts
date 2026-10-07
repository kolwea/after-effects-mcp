import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeClient, discoveryFile } from "./bridge.js";

const server = new McpServer({ name: "AfterEffectsServer", version: "2.0.0" });
const bridge = new BridgeClient();

// ---- Shared schema pieces ----

const vec2 = z.array(z.number()).length(2);
const vec2or3 = z.array(z.number()).min(2).max(3);
const rgb01 = z.array(z.number().min(0).max(1)).length(3).describe("RGB, each channel 0-1");

// Comp targeting. Prefer compName: indices shift whenever the user adds or sorts project items.
const compTarget = {
  compName: z.string().optional().describe("Exact composition name. Preferred way to target a comp."),
  compId: z.number().int().positive().optional().describe("Composition item id (from get-project-info)."),
  compIndex: z.number().int().positive().optional().describe("Nth composition in the project (1-based). Fragile; prefer compName.")
};

const layerTarget = {
  layerName: z.string().optional().describe("Exact layer name. Preferred way to target a layer."),
  layerIndex: z.number().int().positive().optional().describe("1-based layer index within the comp.")
};

type Args = Record<string, unknown>;

function hasCompTarget(args: Args): boolean {
  return args.compName !== undefined || args.compId !== undefined || args.compIndex !== undefined;
}

function hasLayerTarget(args: Args): boolean {
  return args.layerName !== undefined || args.layerIndex !== undefined;
}

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError
  };
}

function looksFailed(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Args;
  return r.status === "error" || r.success === false || typeof r.error === "string";
}

type Options = {
  // Mutating commands must name their comp. Falling back to whatever comp is active is how
  // edits end up in the user's real work.
  requireComp?: boolean;
  requireLayer?: boolean;
  timeoutMs?: number;
};

// server.tool's generics recurse too deeply on a shape typed as ZodRawShape, so register through a plain signature.
type ToolResult = ReturnType<typeof text>;
const registerTool = server.tool.bind(server) as unknown as
  (name: string, description: string, shape: z.ZodRawShape, cb: (args: Args) => Promise<ToolResult>) => void;

function command(name: string, aeCommand: string, description: string, shape: z.ZodRawShape, opts: Options = {}) {
  registerTool(name, description, shape, async (args: Args) => {
    if (opts.requireComp && !hasCompTarget(args)) {
      return text("Refused: name the target comp with compName (or compId). This command changes the project.", true);
    }
    if (opts.requireLayer && !hasLayerTarget(args)) {
      return text("Refused: name the target layer with layerName (or layerIndex).", true);
    }
    try {
      const result = await bridge.call(aeCommand, args, opts.timeoutMs);
      return text(result, looksFailed(result));
    } catch (err) {
      return text(String(err instanceof Error ? err.message : err), true);
    }
  });
}

// ---- Read-only ----

server.tool("bridge-status", "Check the connection to the After Effects MCP Bridge panel.", {}, async () => {
  try {
    const result = await bridge.call("__ping", {}, 5_000);
    return text({ connected: true, discoveryFile: discoveryFile(), ...(result as Args) });
  } catch (err) {
    return text({ connected: false, discoveryFile: discoveryFile(), error: String(err instanceof Error ? err.message : err) }, true);
  }
});

command("get-project-info", "getProjectInfo",
  "Project name, path, items (with ids) and the active comp. Call this before editing to confirm targets.", {});

command("list-compositions", "listCompositions", "List all compositions in the project.", {});

command("get-layer-info", "getLayerInfo",
  "List layers of a comp (name, index, type, timing, transform). Defaults to the active comp.", { ...compTarget });

// ---- Create ----

command("create-composition", "createComposition", "Create a new composition.", {
  name: z.string().describe("Composition name"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pixelAspect: z.number().positive().optional().describe("Default 1.0"),
  duration: z.number().positive().optional().describe("Seconds, default 10"),
  frameRate: z.number().positive().optional().describe("Default 30"),
  backgroundColor: z.object({ r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255) })
    .optional().describe("RGB 0-255 (this one tool uses 0-255; layer colors use 0-1)")
});

command("create-text-layer", "createTextLayer", "Add a text layer to a comp.", {
  ...compTarget,
  text: z.string(),
  position: vec2.optional().describe("[x, y] in comp pixels, default comp center-ish [960, 540]"),
  fontSize: z.number().positive().optional(),
  color: rgb01.optional(),
  fontFamily: z.string().optional().describe("PostScript font name, e.g. 'Arial-BoldMT'"),
  alignment: z.enum(["left", "center", "right"]).optional(),
  startTime: z.number().optional(),
  duration: z.number().positive().optional()
}, { requireComp: true });

command("create-shape-layer", "createShapeLayer", "Add a shape layer (rectangle, ellipse, polygon, star).", {
  ...compTarget,
  shapeType: z.enum(["rectangle", "ellipse", "polygon", "star"]).optional(),
  name: z.string().optional(),
  position: vec2.optional(),
  size: vec2.optional().describe("[width, height]"),
  fillColor: rgb01.optional(),
  strokeColor: rgb01.optional(),
  strokeWidth: z.number().min(0).optional(),
  points: z.number().int().min(3).optional().describe("Polygon/star point count"),
  startTime: z.number().optional(),
  duration: z.number().positive().optional()
}, { requireComp: true });

command("create-solid-layer", "createSolidLayer", "Add a solid or adjustment layer.", {
  ...compTarget,
  name: z.string().optional(),
  color: rgb01.optional(),
  size: vec2.optional().describe("[width, height], default comp size"),
  position: vec2.optional(),
  isAdjustment: z.boolean().optional(),
  startTime: z.number().optional(),
  duration: z.number().positive().optional()
}, { requireComp: true });

command("create-camera", "createCamera", "Add a camera layer.", {
  ...compTarget,
  name: z.string().optional(),
  zoom: z.number().positive().optional(),
  position: z.array(z.number()).length(3).optional(),
  pointOfInterest: z.array(z.number()).length(3).optional(),
  oneNode: z.boolean().optional()
}, { requireComp: true });

// ---- Modify ----

const blendModes = z.enum(["normal", "add", "multiply", "screen", "overlay", "softLight", "hardLight", "colorDodge",
  "colorBurn", "darken", "lighten", "difference", "exclusion", "hue", "saturation", "color", "luminosity"]);

command("set-layer-properties", "setLayerProperties",
  "Set static layer properties. Note: setting position removes existing position keyframes.", {
  ...compTarget,
  ...layerTarget,
  position: vec2or3.optional(),
  scale: vec2or3.optional().describe("Percent, e.g. [100, 100]"),
  rotation: z.number().optional(),
  opacity: z.number().min(0).max(100).optional(),
  startTime: z.number().optional(),
  duration: z.number().positive().optional(),
  enabled: z.boolean().optional(),
  threeDLayer: z.boolean().optional(),
  blendMode: blendModes.optional(),
  trackMatteType: z.enum(["none", "alpha", "alphaInverted", "luma", "lumaInverted"]).optional(),
  text: z.string().optional().describe("Text layers only"),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fillColor: rgb01.optional().describe("Text color")
}, { requireComp: true, requireLayer: true });

command("batch-set-layer-properties", "batchSetLayerProperties", "Apply several layer property changes in one call.", {
  ...compTarget,
  operations: z.array(z.record(z.string(), z.unknown())).min(1)
    .describe("Each item: { layerName | layerIndex, position?, scale?, rotation?, opacity?, threeDLayer?, blendMode?, startTime?, ... }")
}, { requireComp: true });

command("set-composition-properties", "setCompositionProperties", "Change a comp's duration, frame rate or size.", {
  ...compTarget,
  duration: z.number().positive().optional(),
  frameRate: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
}, { requireComp: true });

command("set-layer-keyframe", "setLayerKeyframe", "Set a keyframe on a layer property.", {
  ...compTarget,
  ...layerTarget,
  propertyName: z.string().describe("e.g. 'Position', 'Scale', 'Rotation', 'Opacity', or an effect property name"),
  timeInSeconds: z.number(),
  value: z.unknown().describe("Number or array matching the property, e.g. [x, y] for Position")
}, { requireComp: true, requireLayer: true });

command("set-layer-expression", "setLayerExpression", "Set or remove (empty string) an expression on a layer property.", {
  ...compTarget,
  ...layerTarget,
  propertyName: z.string(),
  expressionString: z.string()
}, { requireComp: true, requireLayer: true });

command("set-layer-mask", "setLayerMask", "Create a mask, or modify one when maskIndex is given.", {
  ...compTarget,
  ...layerTarget,
  maskIndex: z.number().int().positive().optional(),
  maskPath: z.array(vec2).optional().describe("Closed polygon as [[x, y], ...]"),
  maskRect: z.object({ top: z.number(), left: z.number(), width: z.number(), height: z.number() }).optional(),
  maskMode: z.enum(["add", "subtract", "intersect", "lighten", "darken", "difference", "none"]).optional(),
  maskFeather: vec2.optional(),
  maskOpacity: z.number().min(0).max(100).optional(),
  maskExpansion: z.number().optional(),
  maskName: z.string().optional()
}, { requireComp: true, requireLayer: true });

command("duplicate-layer", "duplicateLayer", "Duplicate a layer, optionally renaming the copy.", {
  ...compTarget,
  ...layerTarget,
  newName: z.string().optional()
}, { requireComp: true, requireLayer: true });

command("delete-layer", "deleteLayer", "Delete a layer.", {
  ...compTarget,
  ...layerTarget
}, { requireComp: true, requireLayer: true });

// ---- Effects ----

command("apply-effect", "applyEffect",
  "Apply an effect by match name (preferred, e.g. 'ADBE Gaussian Blur 2'), display name, or .ffx preset.", {
  ...compTarget,
  ...layerTarget,
  effectMatchName: z.string().optional(),
  effectName: z.string().optional(),
  presetPath: z.string().optional().describe("Absolute path to an .ffx preset"),
  effectSettings: z.record(z.string(), z.unknown()).optional().describe("e.g. { \"Blurriness\": 25 }")
}, { requireComp: true, requireLayer: true });

command("apply-effect-template", "applyEffectTemplate", "Apply a predefined effect stack.", {
  ...compTarget,
  ...layerTarget,
  templateName: z.enum(["gaussian-blur", "directional-blur", "color-balance", "brightness-contrast", "curves",
    "glow", "drop-shadow", "cinematic-look", "text-pop"]),
  customSettings: z.record(z.string(), z.unknown()).optional()
}, { requireComp: true, requireLayer: true });

// ---- Help ----

server.tool("get-help", "How this After Effects MCP works and common effect match names.", {}, async () => text(`# After Effects MCP (WebSocket bridge)

Setup: run \`npm run install-cep\`, restart After Effects, open Window > Extensions > MCP Bridge.
The panel listens on 127.0.0.1 and writes its port and token to ${discoveryFile()}.

Every tool returns the After Effects result directly. Each command is one undo step in AE.

Targeting: commands that change the project require compName (or compId). Use layerName for layers.
Call get-project-info first to see current comps; indices shift when the user edits the project.

Colors: layer colors are RGB 0-1 arrays. create-composition backgroundColor is RGB 0-255.

Common effect match names:
- Gaussian Blur "ADBE Gaussian Blur 2", Directional Blur "ADBE Directional Blur", Radial Blur "ADBE Radial Blur"
- Brightness & Contrast "ADBE Brightness & Contrast 2", Curves "ADBE CurvesCustom", Levels "ADBE Pro Levels2"
- Hue/Saturation "ADBE HUE SATURATION", Exposure "ADBE Exposure2", Vibrance "ADBE Vibrance"
- Glow "ADBE Glow", Drop Shadow "ADBE Drop Shadow", Fractal Noise "ADBE Fractal Noise"`));

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("After Effects MCP server running (WebSocket bridge).");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
