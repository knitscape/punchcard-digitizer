import { html, render } from "lit-html";
import "./style.css";

interface Corner {
  x: number;
  y: number;
}

interface DetectedBlob {
  centerX: number;
  centerY: number;
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Catmull-Rom spline segment evaluation
function catmullRomPoint(
  p0: Corner,
  p1: Corner,
  p2: Corner,
  p3: Corner,
  t: number,
): Corner {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

// Evaluate a Catmull-Rom spline through an array of points at parameter t in [0,1]
function evaluateSplineRaw(points: Corner[], t: number): Corner {
  const n = points.length;
  if (n < 2) return points[0] ?? { x: 0, y: 0 };
  if (n === 2) {
    return {
      x: points[0].x + t * (points[1].x - points[0].x),
      y: points[0].y + t * (points[1].y - points[0].y),
    };
  }
  const segments = n - 1;
  const clamped = Math.max(0, Math.min(1, t));
  const scaledT = clamped * segments;
  const seg = Math.min(Math.floor(scaledT), segments - 1);
  const localT = scaledT - seg;

  const p1 = points[seg];
  const p2 = points[seg + 1];
  // Phantom points at boundaries for smooth endpoints
  const p0 =
    seg > 0 ? points[seg - 1] : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
  const p3 =
    seg + 2 < n ? points[seg + 2] : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };

  return catmullRomPoint(p0, p1, p2, p3, localT);
}

// Convenience wrapper for drawing: evaluate spline through corner + midpoints + corner
function evaluateEdge(
  corner1: Corner,
  midpoints: Corner[],
  corner2: Corner,
  t: number,
): Corner {
  return evaluateSplineRaw([corner1, ...midpoints, corner2], t);
}

// Build cumulative arc-length table for a spline through `points`
function buildArcLengthTable(points: Corner[], numSamples: number): number[] {
  const table = new Array(numSamples + 1);
  table[0] = 0;
  let prev = evaluateSplineRaw(points, 0);
  for (let i = 1; i <= numSamples; i++) {
    const curr = evaluateSplineRaw(points, i / numSamples);
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    table[i] = table[i - 1] + Math.sqrt(dx * dx + dy * dy);
    prev = curr;
  }
  return table;
}

// Evaluate spline with arc-length parameterization using a pre-computed table
function evaluateSplineArcLength(
  points: Corner[],
  table: number[],
  t: number,
): Corner {
  const totalLength = table[table.length - 1];
  if (totalLength === 0) return evaluateSplineRaw(points, t);

  const targetLength = t * totalLength;
  const numSamples = table.length - 1;

  // Binary search for the segment containing targetLength
  let lo = 0;
  let hi = numSamples;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < targetLength) lo = mid;
    else hi = mid;
  }

  const segLen = table[hi] - table[lo];
  const frac = segLen > 0 ? (targetLength - table[lo]) / segLen : 0;
  const rawT = (lo + frac) / numSamples;

  return evaluateSplineRaw(points, rawT);
}

interface AppState {
  uploadedImage: HTMLImageElement | null;
  outputWidth: number;
  outputHeight: number;
  selectionBox: { x: number; y: number; width: number; height: number } | null;
  corners: [Corner, Corner, Corner, Corner] | null;
  edgeMidpoints: [Corner[], Corner[], Corner[], Corner[]] | null;
  midpointsPerEdge: number;
  isDragging: boolean;
  dragStart: { x: number; y: number } | null;
  draggingCornerIndex: number | null;
  draggingMidpointInfo: { edge: number; index: number } | null;
  cellStates: boolean[][];
  showGrid: boolean;
  detectionSensitivity: number;
  neighborhoodRadius: number;
  blobSizePercent: number; // expected blob size as % of cell area (10-100)
  hoveredCell: { row: number; col: number } | null;
}

class PunchcardDigitizer {
  private state: AppState = {
    uploadedImage: null,
    outputWidth: 72,
    outputHeight: 95,
    selectionBox: null,
    corners: null,
    edgeMidpoints: null,
    midpointsPerEdge: 1,
    isDragging: false,
    dragStart: null,
    draggingCornerIndex: null,
    draggingMidpointInfo: null,
    cellStates: [],
    showGrid: false,
    detectionSensitivity: 75,
    neighborhoodRadius: 7,
    blobSizePercent: 50,
    hoveredCell: null,
  };

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private outputCanvas: HTMLCanvasElement | null = null;
  private outputCtx: CanvasRenderingContext2D | null = null;
  private pendingHoverFrame: number | null = null;
  private thresholdDebounceTimer: number | null = null;

  // Offscreen caches for the expensive static layers
  private inputCacheCanvas: HTMLCanvasElement | null = null;
  private inputCacheCtx: CanvasRenderingContext2D | null = null;
  private inputCacheDirty: boolean = true;
  private outputCacheCanvas: HTMLCanvasElement | null = null;
  private outputCacheCtx: CanvasRenderingContext2D | null = null;
  private outputCacheDirty: boolean = true;
  private outputCacheCellSize: number = 0;

  // Cached pixel data for the selection region (avoids repeated getImageData)
  private selectionPixelData: Uint8ClampedArray | null = null;
  private selectionBounds: {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null = null;
  private selectionPixelsDirty: boolean = true;

  // Detected blobs from the last auto-detect run (in rectified pixel space)
  private detectedBlobs: DetectedBlob[] = [];
  private rectifiedCellPx = 0;

  // Detected row/column center positions in grid coordinates (from blob clustering)
  private detectedColPositions: number[] = [];
  private detectedRowPositions: number[] = [];

  // Cached arc-length tables for edge splines (rebuilt when edges change)
  private edgePointArrays: [Corner[], Corner[], Corner[], Corner[]] | null =
    null;
  private edgeArcTables: [number[], number[], number[], number[]] | null = null;
  private edgeArcTablesDirty = true;

  // View transform for pan/zoom
  private viewScale = 1;
  private viewOffsetX = 0;
  private viewOffsetY = 0;
  private isPanning = false;
  private panLastX = 0;
  private panLastY = 0;

  constructor(private container: HTMLElement) {
    this.render();
  }

  private invalidateInputCache() {
    this.inputCacheDirty = true;
    this.selectionPixelsDirty = true;
    this.edgeArcTablesDirty = true;
  }

  private invalidateCaches() {
    this.inputCacheDirty = true;
    this.outputCacheDirty = true;
    this.selectionPixelsDirty = true;
    this.edgeArcTablesDirty = true;
  }

  private ensureEdgeArcTables(): void {
    if (!this.edgeArcTablesDirty && this.edgeArcTables) return;
    if (!this.state.corners) {
      this.edgeArcTables = null;
      this.edgePointArrays = null;
      return;
    }

    const [tl, tr, br, bl] = this.state.corners;
    const mids = this.state.edgeMidpoints;
    const numSamples = 200;

    this.edgePointArrays = [
      [tl, ...(mids ? mids[0] : []), tr],
      [tr, ...(mids ? mids[1] : []), br],
      [bl, ...(mids ? mids[2] : []), br],
      [tl, ...(mids ? mids[3] : []), bl],
    ];

    this.edgeArcTables = [
      buildArcLengthTable(this.edgePointArrays[0], numSamples),
      buildArcLengthTable(this.edgePointArrays[1], numSamples),
      buildArcLengthTable(this.edgePointArrays[2], numSamples),
      buildArcLengthTable(this.edgePointArrays[3], numSamples),
    ];

    this.edgeArcTablesDirty = false;
  }

  private createMidpoints(start: Corner, end: Corner, count: number): Corner[] {
    const mids: Corner[] = [];
    for (let i = 1; i <= count; i++) {
      const t = i / (count + 1);
      mids.push({
        x: start.x + t * (end.x - start.x),
        y: start.y + t * (end.y - start.y),
      });
    }
    return mids;
  }

  private initEdgeMidpoints(): void {
    if (!this.state.corners) return;
    const [tl, tr, br, bl] = this.state.corners;
    const n = this.state.midpointsPerEdge;
    this.state.edgeMidpoints = [
      this.createMidpoints(tl, tr, n),
      this.createMidpoints(tr, br, n),
      this.createMidpoints(bl, br, n),
      this.createMidpoints(tl, bl, n),
    ];
  }

  private reinitMidpoints(): void {
    if (!this.state.corners) return;
    const [tl, tr, br, bl] = this.state.corners;
    const n = this.state.midpointsPerEdge;
    this.state.edgeMidpoints = [
      this.createMidpoints(tl, tr, n),
      this.createMidpoints(tr, br, n),
      this.createMidpoints(bl, br, n),
      this.createMidpoints(tl, bl, n),
    ];
  }

  private handleImageUpload = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        this.state.uploadedImage = img;
        this.state.selectionBox = null;
        this.state.corners = null;
        this.state.edgeMidpoints = null;
        this.state.showGrid = false;
        this.state.cellStates = [];
        this.detectedBlobs = [];
        this.detectedColPositions = [];
        this.detectedRowPositions = [];
        this.viewScale = 1;
        this.viewOffsetX = 0;
        this.viewOffsetY = 0;
        this.render();
      };
      img.src = evt.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  private getCanvasCoords(e: MouseEvent): { x: number; y: number } | null {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const canvasX = (e.clientX - rect.left) * scaleX;
    const canvasY = (e.clientY - rect.top) * scaleY;
    return {
      x: (canvasX - this.viewOffsetX) / this.viewScale,
      y: (canvasY - this.viewOffsetY) / this.viewScale,
    };
  }

  private getScreenCoords(e: MouseEvent): { x: number; y: number } | null {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx * this.viewScale + this.viewOffsetX,
      y: wy * this.viewScale + this.viewOffsetY,
    };
  }

  private handleMouseDown = (e: MouseEvent) => {
    // Middle mouse button or Alt+left click: start panning
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      const screenCoords = this.getScreenCoords(e);
      if (!screenCoords) return;
      this.isPanning = true;
      this.panLastX = screenCoords.x;
      this.panLastY = screenCoords.y;
      if (this.canvas) this.canvas.style.cursor = "grabbing";
      return;
    }

    const coords = this.getCanvasCoords(e);
    if (!coords) return;

    // Check if clicking on a corner handle
    if (this.state.corners) {
      const cornerIdx = this.getCornerAtPoint(coords.x, coords.y);
      if (cornerIdx !== null) {
        this.state.draggingCornerIndex = cornerIdx;
        return;
      }

      // Check if clicking on a midpoint handle
      const midInfo = this.getMidpointAtPoint(coords.x, coords.y);
      if (midInfo !== null) {
        this.state.draggingMidpointInfo = midInfo;
        return;
      }
    }

    // Check if clicking on existing cell
    if (this.state.showGrid && this.state.selectionBox) {
      const cellClicked = this.getCellAtPoint(coords.x, coords.y);
      if (cellClicked) {
        this.toggleCell(cellClicked.col, cellClicked.row);
        return;
      }
    }

    // Only allow starting a new selection if no corners exist yet
    if (!this.state.corners) {
      this.state.isDragging = true;
      this.state.dragStart = coords;
      this.state.showGrid = false;
    }
  };

  private handleMouseMove = (e: MouseEvent) => {
    // Handle panning
    if (this.isPanning) {
      const screenCoords = this.getScreenCoords(e);
      if (!screenCoords) return;
      this.viewOffsetX += screenCoords.x - this.panLastX;
      this.viewOffsetY += screenCoords.y - this.panLastY;
      this.panLastX = screenCoords.x;
      this.panLastY = screenCoords.y;
      this.drawCanvas();
      return;
    }

    const coords = this.getCanvasCoords(e);
    if (!coords) return;

    // Change cursor when hovering over handles
    if (
      this.state.corners &&
      this.state.draggingCornerIndex === null &&
      this.state.draggingMidpointInfo === null &&
      !this.state.isDragging
    ) {
      const cornerIdx = this.getCornerAtPoint(coords.x, coords.y);
      const midInfo =
        cornerIdx === null ? this.getMidpointAtPoint(coords.x, coords.y) : null;
      if (this.canvas) {
        if (e.altKey) {
          this.canvas.style.cursor = "grab";
        } else {
          this.canvas.style.cursor =
            cornerIdx !== null || midInfo !== null ? "move" : "crosshair";
        }
      }
    }

    // Handle corner dragging
    if (this.state.draggingCornerIndex !== null && this.state.corners) {
      if (this.canvas) {
        this.canvas.style.cursor = "move";
      }
      this.state.corners[this.state.draggingCornerIndex] = {
        x: coords.x,
        y: coords.y,
      };
      this.detectedBlobs = [];
      this.detectedColPositions = [];
      this.detectedRowPositions = [];
      this.invalidateInputCache();
      this.drawCanvas();
      return;
    }

    // Handle midpoint dragging
    if (this.state.draggingMidpointInfo !== null && this.state.edgeMidpoints) {
      if (this.canvas) {
        this.canvas.style.cursor = "move";
      }
      const { edge, index } = this.state.draggingMidpointInfo;
      this.state.edgeMidpoints[edge][index] = {
        x: coords.x,
        y: coords.y,
      };
      this.detectedBlobs = [];
      this.detectedColPositions = [];
      this.detectedRowPositions = [];
      this.invalidateInputCache();
      this.drawCanvas();
      return;
    }

    // Handle selection box dragging
    if (this.state.isDragging && this.state.dragStart) {
      const x = Math.min(this.state.dragStart.x, coords.x);
      const y = Math.min(this.state.dragStart.y, coords.y);
      const width = Math.abs(coords.x - this.state.dragStart.x);
      const height = Math.abs(coords.y - this.state.dragStart.y);

      this.state.selectionBox = { x, y, width, height };
      this.drawCanvas();
      return;
    }

    // Update hovered cell if grid is showing (debounced via rAF)
    if (this.state.showGrid && this.state.corners) {
      const cellClicked = this.getCellAtPoint(coords.x, coords.y);
      const newHoveredCell = cellClicked;

      if (
        (this.state.hoveredCell === null && newHoveredCell !== null) ||
        (this.state.hoveredCell !== null && newHoveredCell === null) ||
        (this.state.hoveredCell !== null &&
          newHoveredCell !== null &&
          (this.state.hoveredCell.row !== newHoveredCell.row ||
            this.state.hoveredCell.col !== newHoveredCell.col))
      ) {
        this.state.hoveredCell = newHoveredCell;
        if (this.pendingHoverFrame === null) {
          this.pendingHoverFrame = requestAnimationFrame(() => {
            this.pendingHoverFrame = null;
            this.drawCanvas();
            this.drawOutputCanvas();
          });
        }
      }
    }
  };

  private handleMouseUp = () => {
    if (this.canvas) {
      this.canvas.style.cursor = "crosshair";
    }

    // Finish panning
    if (this.isPanning) {
      this.isPanning = false;
      return;
    }

    // Finish corner dragging
    if (this.state.draggingCornerIndex !== null) {
      this.state.draggingCornerIndex = null;
      this.drawCanvas();
      return;
    }

    // Finish midpoint dragging
    if (this.state.draggingMidpointInfo !== null) {
      this.state.draggingMidpointInfo = null;
      this.drawCanvas();
      return;
    }

    // Finish selection box dragging
    if (this.state.isDragging) {
      this.state.isDragging = false;
      this.state.dragStart = null;
      if (
        this.state.selectionBox &&
        this.state.selectionBox.width > 10 &&
        this.state.selectionBox.height > 10
      ) {
        const { x, y, width, height } = this.state.selectionBox;
        const tl = { x, y };
        const tr = { x: x + width, y };
        const br = { x: x + width, y: y + height };
        const bl = { x, y: y + height };
        this.state.corners = [tl, tr, br, bl];
        this.initEdgeMidpoints();
        this.render();
      }
    }
  };

  private handleMouseLeave = () => {
    this.handleMouseUp();
    if (this.state.hoveredCell !== null) {
      this.state.hoveredCell = null;
      this.drawCanvas();
      this.drawOutputCanvas();
    }
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const screenCoords = this.getScreenCoords(e as MouseEvent);
    if (!screenCoords) return;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(0.1, Math.min(30, this.viewScale * zoomFactor));

    // Zoom toward the mouse position
    this.viewOffsetX =
      screenCoords.x -
      (screenCoords.x - this.viewOffsetX) * (newScale / this.viewScale);
    this.viewOffsetY =
      screenCoords.y -
      (screenCoords.y - this.viewOffsetY) * (newScale / this.viewScale);
    this.viewScale = newScale;

    this.drawCanvas();
  };

  private resetView = () => {
    this.viewScale = 1;
    this.viewOffsetX = 0;
    this.viewOffsetY = 0;
    this.drawCanvas();
  };

  private getOutputCellAtCoords(
    e: MouseEvent,
  ): { row: number; col: number } | null {
    if (!this.outputCanvas || this.outputCacheCellSize === 0) return null;
    const rect = this.outputCanvas.getBoundingClientRect();
    const scaleX = this.outputCanvas.width / rect.width;
    const scaleY = this.outputCanvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const col = Math.floor(x / this.outputCacheCellSize);
    const row = Math.floor(y / this.outputCacheCellSize);
    if (
      col >= 0 &&
      col < this.state.outputWidth &&
      row >= 0 &&
      row < this.state.outputHeight
    ) {
      return { row, col };
    }
    return null;
  }

  private handleOutputMouseDown = (e: MouseEvent) => {
    const cell = this.getOutputCellAtCoords(e);
    if (cell) {
      this.toggleCell(cell.col, cell.row);
    }
  };

  private handleOutputMouseMove = (e: MouseEvent) => {
    const cell = this.getOutputCellAtCoords(e);
    if (
      (this.state.hoveredCell === null && cell !== null) ||
      (this.state.hoveredCell !== null && cell === null) ||
      (this.state.hoveredCell !== null &&
        cell !== null &&
        (this.state.hoveredCell.row !== cell.row ||
          this.state.hoveredCell.col !== cell.col))
    ) {
      this.state.hoveredCell = cell;
      if (this.pendingHoverFrame === null) {
        this.pendingHoverFrame = requestAnimationFrame(() => {
          this.pendingHoverFrame = null;
          this.drawCanvas();
          this.drawOutputCanvas();
        });
      }
    }
  };

  private handleOutputMouseLeave = () => {
    if (this.state.hoveredCell !== null) {
      this.state.hoveredCell = null;
      this.drawCanvas();
      this.drawOutputCanvas();
    }
  };

  private getCornerAtPoint(x: number, y: number): number | null {
    if (!this.state.corners) return null;

    const invScale = 1 / this.viewScale;
    const cornerRadius = 60 * invScale;
    for (let i = 0; i < 4; i++) {
      const corner = this.state.corners[i];
      const dist = Math.sqrt((x - corner.x) ** 2 + (y - corner.y) ** 2);
      if (dist <= cornerRadius) {
        return i;
      }
    }

    return null;
  }

  private getMidpointAtPoint(
    x: number,
    y: number,
  ): { edge: number; index: number } | null {
    if (!this.state.edgeMidpoints) return null;

    const invScale = 1 / this.viewScale;
    const midRadius = 45 * invScale;
    for (let edge = 0; edge < 4; edge++) {
      const mids = this.state.edgeMidpoints[edge];
      for (let idx = 0; idx < mids.length; idx++) {
        const pt = mids[idx];
        const dist = Math.sqrt((x - pt.x) ** 2 + (y - pt.y) ** 2);
        if (dist <= midRadius) {
          return { edge, index: idx };
        }
      }
    }

    return null;
  }

  private getCellAtPoint(
    x: number,
    y: number,
  ): { row: number; col: number } | null {
    if (!this.state.corners || !this.state.showGrid) return null;

    // Use inverse perspective transform to map click point to grid coordinates
    const gridCoords = this.inverseTransformPoint(x, y);
    if (!gridCoords) return null;

    const col = Math.floor(gridCoords.x);
    const row = Math.floor(gridCoords.y);

    if (
      col >= 0 &&
      col < this.state.outputWidth &&
      row >= 0 &&
      row < this.state.outputHeight
    ) {
      return { row, col };
    }
    return null;
  }

  private toggleCell(col: number, row: number) {
    if (!this.state.cellStates[row]) return;
    this.state.cellStates[row][col] = !this.state.cellStates[row][col];
    this.invalidateCaches();
    this.drawCanvas();
    this.drawOutputCanvas();
  }

  // Coons patch from grid coordinates to canvas coordinates
  // col should be in range [0, outputWidth], row in range [0, outputHeight]
  private transformPoint(col: number, row: number): Corner | null {
    if (!this.state.corners) return null;

    const u = col / this.state.outputWidth;
    const v = row / this.state.outputHeight;

    const [tl, tr, br, bl] = this.state.corners;
    const mids = this.state.edgeMidpoints;

    if (!mids) {
      // Fallback to bilinear if no midpoints
      return {
        x:
          (1 - u) * (1 - v) * tl.x +
          u * (1 - v) * tr.x +
          u * v * br.x +
          (1 - u) * v * bl.x,
        y:
          (1 - u) * (1 - v) * tl.y +
          u * (1 - v) * tr.y +
          u * v * br.y +
          (1 - u) * v * bl.y,
      };
    }

    // Use arc-length parameterized Catmull-Rom splines
    this.ensureEdgeArcTables();
    if (!this.edgePointArrays || !this.edgeArcTables) {
      return {
        x:
          (1 - u) * (1 - v) * tl.x +
          u * (1 - v) * tr.x +
          u * v * br.x +
          (1 - u) * v * bl.x,
        y:
          (1 - u) * (1 - v) * tl.y +
          u * (1 - v) * tr.y +
          u * v * br.y +
          (1 - u) * v * bl.y,
      };
    }

    const [topPts, rightPts, bottomPts, leftPts] = this.edgePointArrays;
    const [topTbl, rightTbl, bottomTbl, leftTbl] = this.edgeArcTables;

    const topPt = evaluateSplineArcLength(topPts, topTbl, u);
    const botPt = evaluateSplineArcLength(bottomPts, bottomTbl, u);
    const leftPt = evaluateSplineArcLength(leftPts, leftTbl, v);
    const rightPt = evaluateSplineArcLength(rightPts, rightTbl, v);

    // Coons patch formula
    const x =
      (1 - v) * topPt.x +
      v * botPt.x +
      (1 - u) * leftPt.x +
      u * rightPt.x -
      ((1 - u) * (1 - v) * tl.x +
        u * (1 - v) * tr.x +
        u * v * br.x +
        (1 - u) * v * bl.x);
    const y =
      (1 - v) * topPt.y +
      v * botPt.y +
      (1 - u) * leftPt.y +
      u * rightPt.y -
      ((1 - u) * (1 - v) * tl.y +
        u * (1 - v) * tr.y +
        u * v * br.y +
        (1 - u) * v * bl.y);

    return { x, y };
  }

  private inverseTransformPoint(
    x: number,
    y: number,
  ): { x: number; y: number } | null {
    if (!this.state.corners) return null;

    // Use Newton's method to find (u, v) such that transformPoint maps to (x, y)
    const outW = this.state.outputWidth;
    const outH = this.state.outputHeight;
    let u = 0.5,
      v = 0.5;
    for (let iter = 0; iter < 15; iter++) {
      const pt = this.transformPoint(u * outW, v * outH);
      if (!pt) break;

      const dx = x - pt.x;
      const dy = y - pt.y;

      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;

      // Numerical Jacobian
      const du = 0.001;
      const dv = 0.001;
      const ptU = this.transformPoint((u + du) * outW, v * outH);
      const ptV = this.transformPoint(u * outW, (v + dv) * outH);
      if (!ptU || !ptV) break;

      const grad_u_x = (ptU.x - pt.x) / du;
      const grad_u_y = (ptU.y - pt.y) / du;
      const grad_v_x = (ptV.x - pt.x) / dv;
      const grad_v_y = (ptV.y - pt.y) / dv;

      const det = grad_u_x * grad_v_y - grad_u_y * grad_v_x;
      if (Math.abs(det) < 0.0001) break;

      const du_step = (grad_v_y * dx - grad_v_x * dy) / det;
      const dv_step = (-grad_u_y * dx + grad_u_x * dy) / det;

      u += du_step * 0.5;
      v += dv_step * 0.5;
    }

    // If the point is outside the quadrilateral, return null
    if (u < -0.001 || u > 1.001 || v < -0.001 || v > 1.001) return null;

    return {
      x: u * this.state.outputWidth,
      y: v * this.state.outputHeight,
    };
  }

  private rebuildSelectionPixelData() {
    if (!this.state.uploadedImage || !this.state.corners || !this.canvas)
      return;

    const allPoints: Corner[] = [...this.state.corners];
    if (this.state.edgeMidpoints) {
      for (const mids of this.state.edgeMidpoints) {
        allPoints.push(...mids);
      }
    }

    const minX = Math.max(
      0,
      Math.floor(Math.min(...allPoints.map((p) => p.x))),
    );
    const minY = Math.max(
      0,
      Math.floor(Math.min(...allPoints.map((p) => p.y))),
    );
    const maxX = Math.min(
      this.canvas.width,
      Math.ceil(Math.max(...allPoints.map((p) => p.x))),
    );
    const maxY = Math.min(
      this.canvas.height,
      Math.ceil(Math.max(...allPoints.map((p) => p.y))),
    );
    const w = maxX - minX;
    const h = maxY - minY;

    if (w <= 0 || h <= 0) return;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = this.canvas.width;
    tempCanvas.height = this.canvas.height;
    const tempCtx = tempCanvas.getContext("2d")!;
    tempCtx.drawImage(
      this.state.uploadedImage,
      0,
      0,
      tempCanvas.width,
      tempCanvas.height,
    );

    this.selectionPixelData = tempCtx.getImageData(minX, minY, w, h).data;
    this.selectionBounds = { x: minX, y: minY, w, h };
    this.selectionPixelsDirty = false;
  }

  // --- Blob Detection Pipeline ---

  private createRectifiedGrayscale(cellPx: number): {
    data: Uint8Array;
    width: number;
    height: number;
  } | null {
    if (!this.selectionPixelData || !this.selectionBounds) return null;

    const w = this.state.outputWidth * cellPx;
    const h = this.state.outputHeight * cellPx;
    const gray = new Uint8Array(w * h);

    const srcData = this.selectionPixelData;
    const bx = this.selectionBounds.x;
    const by = this.selectionBounds.y;
    const bw = this.selectionBounds.w;
    const bh = this.selectionBounds.h;

    for (let ry = 0; ry < h; ry++) {
      for (let rx = 0; rx < w; rx++) {
        const gridCol = rx / cellPx;
        const gridRow = ry / cellPx;
        const pt = this.transformPoint(gridCol, gridRow);
        if (!pt) {
          gray[ry * w + rx] = 128;
          continue;
        }

        const px = Math.floor(pt.x) - bx;
        const py = Math.floor(pt.y) - by;

        if (px >= 0 && px < bw && py >= 0 && py < bh) {
          const idx = (py * bw + px) * 4;
          gray[ry * w + rx] = Math.round(
            (srcData[idx] + srcData[idx + 1] + srcData[idx + 2]) / 3,
          );
        } else {
          gray[ry * w + rx] = 128;
        }
      }
    }

    return { data: gray, width: w, height: h };
  }

  private adaptiveThreshold(
    gray: Uint8Array,
    w: number,
    h: number,
    windowRadius: number,
    sensitivity: number,
  ): Uint8Array {
    const iw = w + 1;
    const integral = new Float64Array(iw * (h + 1));
    for (let y = 1; y <= h; y++) {
      for (let x = 1; x <= w; x++) {
        integral[y * iw + x] =
          gray[(y - 1) * w + (x - 1)] +
          integral[(y - 1) * iw + x] +
          integral[y * iw + (x - 1)] -
          integral[(y - 1) * iw + (x - 1)];
      }
    }

    const binary = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - windowRadius);
        const y1 = Math.max(0, y - windowRadius);
        const x2 = Math.min(w - 1, x + windowRadius);
        const y2 = Math.min(h - 1, y + windowRadius);
        const count = (x2 - x1 + 1) * (y2 - y1 + 1);

        const sum =
          integral[(y2 + 1) * iw + (x2 + 1)] -
          integral[y1 * iw + (x2 + 1)] -
          integral[(y2 + 1) * iw + x1] +
          integral[y1 * iw + x1];
        const localMean = sum / count;

        binary[y * w + x] = gray[y * w + x] < localMean - sensitivity ? 1 : 0;
      }
    }

    return binary;
  }

  private connectedComponentLabeling(
    binary: Uint8Array,
    w: number,
    h: number,
  ): DetectedBlob[] {
    const labels = new Int32Array(w * h);
    const parent: number[] = [0];
    let nextLabel = 1;

    function find(x: number): number {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }

    function union(a: number, b: number): void {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    // First pass: assign provisional labels
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (binary[idx] === 0) continue;

        const left = x > 0 ? labels[idx - 1] : 0;
        const up = y > 0 ? labels[idx - w] : 0;

        if (left === 0 && up === 0) {
          labels[idx] = nextLabel;
          parent.push(nextLabel);
          nextLabel++;
        } else if (left !== 0 && up === 0) {
          labels[idx] = left;
        } else if (left === 0 && up !== 0) {
          labels[idx] = up;
        } else {
          labels[idx] = left;
          if (left !== up) union(left, up);
        }
      }
    }

    // Second pass: resolve labels and compute blob stats
    const blobMap = new Map<
      number,
      {
        sumX: number;
        sumY: number;
        area: number;
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
      }
    >();

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (labels[idx] === 0) continue;

        const root = find(labels[idx]);
        labels[idx] = root;

        let stats = blobMap.get(root);
        if (!stats) {
          stats = {
            sumX: 0,
            sumY: 0,
            area: 0,
            minX: x,
            maxX: x,
            minY: y,
            maxY: y,
          };
          blobMap.set(root, stats);
        }
        stats.sumX += x;
        stats.sumY += y;
        stats.area++;
        stats.minX = Math.min(stats.minX, x);
        stats.maxX = Math.max(stats.maxX, x);
        stats.minY = Math.min(stats.minY, y);
        stats.maxY = Math.max(stats.maxY, y);
      }
    }

    const blobs: DetectedBlob[] = [];
    for (const [, stats] of blobMap) {
      blobs.push({
        centerX: stats.sumX / stats.area,
        centerY: stats.sumY / stats.area,
        area: stats.area,
        minX: stats.minX,
        maxX: stats.maxX,
        minY: stats.minY,
        maxY: stats.maxY,
      });
    }

    return blobs;
  }

  private filterBlobs(blobs: DetectedBlob[], cellPx: number): DetectedBlob[] {
    const cellArea = cellPx * cellPx;
    const expectedArea = cellArea * (this.state.blobSizePercent / 100);
    const minArea = expectedArea * 0.15;
    const maxArea = expectedArea * 5.0;

    return blobs.filter((blob) => {
      if (blob.area < minArea || blob.area > maxArea) return false;

      const blobW = blob.maxX - blob.minX + 1;
      const blobH = blob.maxY - blob.minY + 1;
      const aspect =
        Math.max(blobW, blobH) / Math.max(1, Math.min(blobW, blobH));
      if (aspect > 5) return false;

      return true;
    });
  }

  private findPeaks(
    positions: number[],
    totalExtent: number,
    numExpected: number,
    minSeparation: number,
  ): number[] {
    if (positions.length === 0) {
      const spacing = totalExtent / numExpected;
      return Array.from({ length: numExpected }, (_, i) => (i + 0.5) * spacing);
    }

    // Build smoothed histogram
    const histSize = Math.ceil(totalExtent);
    const histogram = new Float64Array(histSize);
    const sigma = minSeparation * 0.3;
    const kernelRadius = Math.ceil(sigma * 3);

    for (const pos of positions) {
      const bin = Math.round(pos);
      for (let d = -kernelRadius; d <= kernelRadius; d++) {
        const b = bin + d;
        if (b >= 0 && b < histSize) {
          histogram[b] += Math.exp((-0.5 * d * d) / (sigma * sigma));
        }
      }
    }

    // Find all local maxima
    const peaks: { pos: number; value: number }[] = [];
    for (let i = 1; i < histSize - 1; i++) {
      if (
        histogram[i] > histogram[i - 1] &&
        histogram[i] >= histogram[i + 1] &&
        histogram[i] > 0.01
      ) {
        peaks.push({ pos: i, value: histogram[i] });
      }
    }

    // Sort by strength (strongest first)
    peaks.sort((a, b) => b.value - a.value);

    // Non-maximum suppression with minimum separation
    const selected: number[] = [];
    for (const peak of peaks) {
      if (
        selected.every((s) => Math.abs(s - peak.pos) >= minSeparation * 0.5)
      ) {
        selected.push(peak.pos);
        if (selected.length >= numExpected) break;
      }
    }

    selected.sort((a, b) => a - b);

    // Interpolate any missing positions
    if (selected.length < numExpected) {
      return this.interpolateMissingPositions(
        selected,
        numExpected,
        totalExtent,
      );
    }

    return selected;
  }

  private interpolateMissingPositions(
    detected: number[],
    numExpected: number,
    totalExtent: number,
  ): number[] {
    if (detected.length === 0) {
      const spacing = totalExtent / numExpected;
      return Array.from({ length: numExpected }, (_, i) => (i + 0.5) * spacing);
    }

    const expectedSpacing = totalExtent / numExpected;

    // Assign each detected position to the nearest expected grid index
    const indexMap = new Map<number, number>();
    for (const pos of detected) {
      const approxIdx = Math.round(pos / expectedSpacing - 0.5);
      const idx = Math.max(0, Math.min(numExpected - 1, approxIdx));
      const expected = (idx + 0.5) * expectedSpacing;
      const existing = indexMap.get(idx);
      if (
        existing === undefined ||
        Math.abs(pos - expected) < Math.abs(existing - expected)
      ) {
        indexMap.set(idx, pos);
      }
    }

    // Build full array, interpolating gaps from nearest known positions
    const result: number[] = [];
    for (let i = 0; i < numExpected; i++) {
      const known = indexMap.get(i);
      if (known !== undefined) {
        result.push(known);
      } else {
        let prevIdx = -1;
        let nextIdx = -1;
        for (let j = i - 1; j >= 0; j--) {
          if (indexMap.has(j)) {
            prevIdx = j;
            break;
          }
        }
        for (let j = i + 1; j < numExpected; j++) {
          if (indexMap.has(j)) {
            nextIdx = j;
            break;
          }
        }

        if (prevIdx >= 0 && nextIdx >= 0) {
          const prevPos = indexMap.get(prevIdx)!;
          const nextPos = indexMap.get(nextIdx)!;
          const t = (i - prevIdx) / (nextIdx - prevIdx);
          result.push(prevPos + t * (nextPos - prevPos));
        } else if (prevIdx >= 0) {
          const prevPos = indexMap.get(prevIdx)!;
          result.push(prevPos + (i - prevIdx) * expectedSpacing);
        } else if (nextIdx >= 0) {
          const nextPos = indexMap.get(nextIdx)!;
          result.push(nextPos - (nextIdx - i) * expectedSpacing);
        } else {
          result.push((i + 0.5) * expectedSpacing);
        }
      }
    }

    return result;
  }

  private assignBlobsToGrid(
    blobs: DetectedBlob[],
    rowPositions: number[],
    colPositions: number[],
  ): boolean[][] {
    const outH = this.state.outputHeight;
    const outW = this.state.outputWidth;

    const cellStates: boolean[][] = Array(outH)
      .fill(null)
      .map(() => Array(outW).fill(false));

    const avgColSpacing =
      colPositions.length > 1
        ? (colPositions[colPositions.length - 1] - colPositions[0]) /
          (colPositions.length - 1)
        : 1;
    const avgRowSpacing =
      rowPositions.length > 1
        ? (rowPositions[rowPositions.length - 1] - rowPositions[0]) /
          (rowPositions.length - 1)
        : 1;

    for (const blob of blobs) {
      let bestRow = 0;
      let bestRowDist = Infinity;
      for (let r = 0; r < rowPositions.length; r++) {
        const dist = Math.abs(blob.centerY - rowPositions[r]);
        if (dist < bestRowDist) {
          bestRowDist = dist;
          bestRow = r;
        }
      }

      let bestCol = 0;
      let bestColDist = Infinity;
      for (let c = 0; c < colPositions.length; c++) {
        const dist = Math.abs(blob.centerX - colPositions[c]);
        if (dist < bestColDist) {
          bestColDist = dist;
          bestCol = c;
        }
      }

      if (
        bestColDist < avgColSpacing * 0.6 &&
        bestRowDist < avgRowSpacing * 0.6
      ) {
        cellStates[bestRow][bestCol] = true;
      }
    }

    return cellStates;
  }

  // --- Auto-Detect Orchestration ---

  private autoDetect = () => {
    const t0 = performance.now();
    if (!this.state.uploadedImage || !this.state.corners || !this.canvas)
      return;

    // Rebuild cached pixel data if needed
    if (
      this.selectionPixelsDirty ||
      !this.selectionPixelData ||
      !this.selectionBounds
    ) {
      this.rebuildSelectionPixelData();
    }
    if (!this.selectionPixelData || !this.selectionBounds) return;

    const cellPx = 10;

    // Step 1: Create rectified grayscale image
    const rectified = this.createRectifiedGrayscale(cellPx);
    if (!rectified) return;

    // Step 2: Adaptive threshold
    const windowRadius = Math.max(3, this.state.neighborhoodRadius * cellPx);
    const binary = this.adaptiveThreshold(
      rectified.data,
      rectified.width,
      rectified.height,
      windowRadius,
      this.state.detectionSensitivity,
    );

    // Step 3: Connected component labeling
    const allBlobs = this.connectedComponentLabeling(
      binary,
      rectified.width,
      rectified.height,
    );

    // Step 4: Filter blobs by size and shape
    const blobs = this.filterBlobs(allBlobs, cellPx);

    // Step 5: Find row and column positions via histogram peaks
    const colPositions = this.findPeaks(
      blobs.map((b) => b.centerX),
      rectified.width,
      this.state.outputWidth,
      cellPx * 0.7,
    );
    const rowPositions = this.findPeaks(
      blobs.map((b) => b.centerY),
      rectified.height,
      this.state.outputHeight,
      cellPx * 0.7,
    );

    // Step 6: Assign blobs to grid cells
    this.state.cellStates = this.assignBlobsToGrid(
      blobs,
      rowPositions,
      colPositions,
    );
    this.state.showGrid = true;

    // Store blobs and detected grid positions for visualization
    this.detectedBlobs = blobs;
    this.rectifiedCellPx = cellPx;
    this.detectedColPositions = colPositions.map((p) => p / cellPx);
    this.detectedRowPositions = rowPositions.map((p) => p / cellPx);

    this.invalidateInputCache();
    this.outputCacheDirty = true;
    console.log(
      `Auto-detect: ${(performance.now() - t0).toFixed(1)}ms - ${allBlobs.length} raw blobs, ${blobs.length} filtered, ${colPositions.length} cols, ${rowPositions.length} rows`,
    );
    this.render();
  };

  private drawCanvas() {
    if (!this.canvas || !this.ctx || !this.state.uploadedImage) return;

    if (this.inputCacheDirty || !this.inputCacheCanvas) {
      this.rebuildInputCache();
    }

    // Dark background visible around edges when zoomed/panned
    this.ctx.fillStyle = "#1f2937";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply view transform for all world-space drawing
    this.ctx.save();
    this.ctx.translate(this.viewOffsetX, this.viewOffsetY);
    this.ctx.scale(this.viewScale, this.viewScale);

    if (this.inputCacheCanvas) {
      this.ctx.drawImage(this.inputCacheCanvas, 0, 0);
    }

    // Scale-compensated sizes so handles appear constant on screen
    const invScale = 1 / this.viewScale;

    // Draw dynamic overlays
    if (this.state.corners) {
      // Highlight hovered cell
      if (this.state.hoveredCell !== null && this.state.showGrid) {
        const { row, col } = this.state.hoveredCell;
        const c0 = this.transformPoint(col, row);
        const c1 = this.transformPoint(col + 1, row);
        const c2 = this.transformPoint(col + 1, row + 1);
        const c3 = this.transformPoint(col, row + 1);
        if (c0 && c1 && c2 && c3) {
          this.ctx.fillStyle = "rgba(59, 130, 246, 0.3)";
          this.ctx.beginPath();
          this.ctx.moveTo(c0.x, c0.y);
          this.ctx.lineTo(c1.x, c1.y);
          this.ctx.lineTo(c2.x, c2.y);
          this.ctx.lineTo(c3.x, c3.y);
          this.ctx.closePath();
          this.ctx.fill();
          this.ctx.strokeStyle = "#3b82f6";
          this.ctx.lineWidth = 2 * invScale;
          this.ctx.stroke();
        }
      }

      // Draw corner handles (constant screen size)
      const handleRadius = 24 * invScale;
      for (let i = 0; i < 4; i++) {
        const corner = this.state.corners[i];
        this.ctx.fillStyle = "#ffffff";
        this.ctx.strokeStyle = "#3b82f6";
        this.ctx.lineWidth = 4 * invScale;
        this.ctx.beginPath();
        this.ctx.arc(corner.x, corner.y, handleRadius, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
      }

      // Draw midpoint handles
      if (this.state.edgeMidpoints) {
        const midRadius = 18 * invScale;
        for (let edge = 0; edge < 4; edge++) {
          for (const pt of this.state.edgeMidpoints[edge]) {
            this.ctx.fillStyle = "#ffffff";
            this.ctx.strokeStyle = "#22c55e";
            this.ctx.lineWidth = 3 * invScale;
            this.ctx.beginPath();
            this.ctx.arc(pt.x, pt.y, midRadius, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.stroke();
          }
        }
      }
    }

    // Draw selection box while dragging (world space)
    if (this.state.isDragging && this.state.selectionBox) {
      const { x, y, width, height } = this.state.selectionBox;
      this.ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
      this.ctx.fillRect(x, y, width, height);
      this.ctx.strokeStyle = "#3b82f6";
      this.ctx.lineWidth = 2 * invScale;
      this.ctx.strokeRect(x, y, width, height);
    }

    // Restore to screen space
    this.ctx.restore();

    // Draw zoom preview in screen space (not affected by pan/zoom)
    if (this.state.draggingCornerIndex !== null && this.state.corners) {
      const dragPt = this.state.corners[this.state.draggingCornerIndex];
      this.drawZoomPreview(dragPt);
    } else if (
      this.state.draggingMidpointInfo !== null &&
      this.state.edgeMidpoints
    ) {
      const { edge, index } = this.state.draggingMidpointInfo;
      const dragPt = this.state.edgeMidpoints[edge][index];
      this.drawZoomPreview(dragPt);
    }
  }

  private rebuildInputCache() {
    if (!this.canvas || !this.state.uploadedImage) return;

    // Create or resize offscreen canvas
    if (!this.inputCacheCanvas) {
      this.inputCacheCanvas = document.createElement("canvas");
      this.inputCacheCtx = this.inputCacheCanvas.getContext("2d");
    }
    this.inputCacheCanvas.width = this.canvas.width;
    this.inputCacheCanvas.height = this.canvas.height;
    const ctx = this.inputCacheCtx;
    if (!ctx) return;

    // Draw image
    ctx.clearRect(
      0,
      0,
      this.inputCacheCanvas.width,
      this.inputCacheCanvas.height,
    );
    ctx.drawImage(
      this.state.uploadedImage,
      0,
      0,
      this.inputCacheCanvas.width,
      this.inputCacheCanvas.height,
    );

    // Draw border and grid if corners are available
    if (this.state.corners) {
      const [tl, tr, br, bl] = this.state.corners;
      const mids = this.state.edgeMidpoints;
      const curveSteps = 30;

      // Draw border as curves (or straight if no midpoints)
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (mids) {
        const [topMid, rightMid, bottomMid, leftMid] = mids;
        for (let s = 0; s <= curveSteps; s++) {
          const t = s / curveSteps;
          const pt = evaluateEdge(tl, topMid, tr, t);
          if (s === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        for (let s = 0; s <= curveSteps; s++) {
          const t = s / curveSteps;
          const pt = evaluateEdge(tr, rightMid, br, t);
          ctx.lineTo(pt.x, pt.y);
        }
        for (let s = curveSteps; s >= 0; s--) {
          const t = s / curveSteps;
          const pt = evaluateEdge(bl, bottomMid, br, t);
          ctx.lineTo(pt.x, pt.y);
        }
        for (let s = curveSteps; s >= 0; s--) {
          const t = s / curveSteps;
          const pt = evaluateEdge(tl, leftMid, bl, t);
          ctx.lineTo(pt.x, pt.y);
        }
      } else {
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tr.x, tr.y);
        ctx.lineTo(br.x, br.y);
        ctx.lineTo(bl.x, bl.y);
      }
      ctx.closePath();
      ctx.stroke();

      // Draw semi-transparent fill
      ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
      ctx.fill();

      // Draw grid if enabled
      if (this.state.showGrid) {
        const gridSteps = 15;
        const hasPeaks =
          this.detectedColPositions.length > 0 &&
          this.detectedRowPositions.length > 0;

        // Draw centerlines through detected peak positions (or boundary grid as fallback)
        ctx.strokeStyle = hasPeaks
          ? "rgba(59, 130, 246, 0.7)"
          : "rgba(0, 0, 0, 0.85)";
        ctx.lineWidth = hasPeaks ? 1 : 0.5;
        ctx.beginPath();

        if (hasPeaks) {
          // Vertical centerlines through detected column positions
          for (const colPos of this.detectedColPositions) {
            for (let s = 0; s <= gridSteps; s++) {
              const row = (s / gridSteps) * this.state.outputHeight;
              const pt = this.transformPoint(colPos, row);
              if (pt) {
                if (s === 0) ctx.moveTo(pt.x, pt.y);
                else ctx.lineTo(pt.x, pt.y);
              }
            }
          }

          // Horizontal centerlines through detected row positions
          for (const rowPos of this.detectedRowPositions) {
            for (let s = 0; s <= gridSteps; s++) {
              const col = (s / gridSteps) * this.state.outputWidth;
              const pt = this.transformPoint(col, rowPos);
              if (pt) {
                if (s === 0) ctx.moveTo(pt.x, pt.y);
                else ctx.lineTo(pt.x, pt.y);
              }
            }
          }
        } else {
          // Fallback: boundary grid lines
          for (let col = 0; col <= this.state.outputWidth; col++) {
            for (let s = 0; s <= gridSteps; s++) {
              const row = (s / gridSteps) * this.state.outputHeight;
              const pt = this.transformPoint(col, row);
              if (pt) {
                if (s === 0) ctx.moveTo(pt.x, pt.y);
                else ctx.lineTo(pt.x, pt.y);
              }
            }
          }
          for (let row = 0; row <= this.state.outputHeight; row++) {
            for (let s = 0; s <= gridSteps; s++) {
              const col = (s / gridSteps) * this.state.outputWidth;
              const pt = this.transformPoint(col, row);
              if (pt) {
                if (s === 0) ctx.moveTo(pt.x, pt.y);
                else ctx.lineTo(pt.x, pt.y);
              }
            }
          }
        }

        ctx.stroke();

        // Compute cell boundary positions from detected peaks (midpoints between
        // adjacent centers), or fall back to integer boundaries
        const colBounds: number[] = [];
        const rowBounds: number[] = [];
        if (hasPeaks) {
          const cp = this.detectedColPositions;
          const rp = this.detectedRowPositions;
          // Left boundary: extrapolate half a cell before first center
          colBounds.push(
            cp.length > 1
              ? cp[0] - (cp[1] - cp[0]) / 2
              : cp[0] - 0.5,
          );
          for (let i = 0; i < cp.length - 1; i++) {
            colBounds.push((cp[i] + cp[i + 1]) / 2);
          }
          colBounds.push(
            cp.length > 1
              ? cp[cp.length - 1] + (cp[cp.length - 1] - cp[cp.length - 2]) / 2
              : cp[cp.length - 1] + 0.5,
          );
          // Top boundary: extrapolate half a cell before first center
          rowBounds.push(
            rp.length > 1
              ? rp[0] - (rp[1] - rp[0]) / 2
              : rp[0] - 0.5,
          );
          for (let i = 0; i < rp.length - 1; i++) {
            rowBounds.push((rp[i] + rp[i + 1]) / 2);
          }
          rowBounds.push(
            rp.length > 1
              ? rp[rp.length - 1] + (rp[rp.length - 1] - rp[rp.length - 2]) / 2
              : rp[rp.length - 1] + 0.5,
          );
        } else {
          for (let i = 0; i <= this.state.outputWidth; i++) colBounds.push(i);
          for (let i = 0; i <= this.state.outputHeight; i++) rowBounds.push(i);
        }

        // Draw all marked cells in a single path using computed boundaries
        ctx.fillStyle = "rgba(239, 68, 68, 0.5)";
        ctx.beginPath();
        const numRows = hasPeaks ? this.detectedRowPositions.length : this.state.outputHeight;
        const numCols = hasPeaks ? this.detectedColPositions.length : this.state.outputWidth;
        for (let row = 0; row < numRows; row++) {
          for (let col = 0; col < numCols; col++) {
            if (this.state.cellStates[row]?.[col]) {
              const c0 = this.transformPoint(colBounds[col], rowBounds[row]);
              const c1 = this.transformPoint(colBounds[col + 1], rowBounds[row]);
              const c2 = this.transformPoint(colBounds[col + 1], rowBounds[row + 1]);
              const c3 = this.transformPoint(colBounds[col], rowBounds[row + 1]);
              if (c0 && c1 && c2 && c3) {
                ctx.moveTo(c0.x, c0.y);
                ctx.lineTo(c1.x, c1.y);
                ctx.lineTo(c2.x, c2.y);
                ctx.lineTo(c3.x, c3.y);
                ctx.closePath();
              }
            }
          }
        }
        ctx.fill();
      }

      // Draw detected blob centers as small green dots
      if (this.detectedBlobs.length > 0 && this.rectifiedCellPx > 0) {
        ctx.fillStyle = "rgba(34, 197, 94, 0.8)";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 1.5;
        for (const blob of this.detectedBlobs) {
          const gridCol = blob.centerX / this.rectifiedCellPx;
          const gridRow = blob.centerY / this.rectifiedCellPx;
          const pt = this.transformPoint(gridCol, gridRow);
          if (pt) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      }
    }

    this.inputCacheDirty = false;
  }

  private drawZoomPreview(point: Corner) {
    if (
      !this.canvas ||
      !this.ctx ||
      !this.state.uploadedImage ||
      !this.state.corners
    )
      return;

    // Position the preview in screen space near the dragged point
    const screenPt = this.worldToScreen(point.x, point.y);
    const zoomSize = Math.min(this.canvas.width, this.canvas.height) * 0.3;
    const zoomFactor = 5;
    const sourceSize = zoomSize / zoomFactor;

    const offset = zoomSize * 0.2;
    let previewX = screenPt.x + offset;
    let previewY = screenPt.y + offset;

    if (previewX + zoomSize > this.canvas.width) {
      previewX = screenPt.x - zoomSize - offset;
    }
    if (previewY + zoomSize > this.canvas.height) {
      previewY = screenPt.y - zoomSize - offset;
    }
    if (previewX < 0) previewX = zoomSize * 0.02;
    if (previewY < 0) previewY = zoomSize * 0.02;

    const borderWidth = Math.max(4, zoomSize * 0.015);
    this.ctx.fillStyle = "#ffffff";
    this.ctx.strokeStyle = "#1e40af";
    this.ctx.lineWidth = borderWidth;
    const borderPadding = borderWidth;
    this.ctx.fillRect(
      previewX - borderPadding,
      previewY - borderPadding,
      zoomSize + borderPadding * 2,
      zoomSize + borderPadding * 2,
    );
    this.ctx.strokeRect(
      previewX - borderPadding,
      previewY - borderPadding,
      zoomSize + borderPadding * 2,
      zoomSize + borderPadding * 2,
    );

    const scaleX = this.state.uploadedImage.width / this.canvas.width;
    const scaleY = this.state.uploadedImage.height / this.canvas.height;

    const imgCornerX = point.x * scaleX;
    const imgCornerY = point.y * scaleY;
    const imgSourceSize = sourceSize * scaleX;

    const sourceX = Math.max(0, imgCornerX - imgSourceSize / 2);
    const sourceY = Math.max(0, imgCornerY - imgSourceSize / 2);
    const actualSourceWidth = Math.min(
      imgSourceSize,
      this.state.uploadedImage.width - sourceX,
    );
    const actualSourceHeight = Math.min(
      imgSourceSize,
      this.state.uploadedImage.height - sourceY,
    );

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(previewX, previewY, zoomSize, zoomSize);
    this.ctx.clip();

    this.ctx.drawImage(
      this.state.uploadedImage,
      sourceX,
      sourceY,
      actualSourceWidth,
      actualSourceHeight,
      previewX,
      previewY,
      (actualSourceWidth / scaleX) * zoomFactor,
      (actualSourceHeight / scaleY) * zoomFactor,
    );

    const centerX = previewX + zoomSize / 2;
    const centerY = previewY + zoomSize / 2;

    // Helper to convert canvas coords to zoom preview coords
    const toPreview = (pt: Corner) => ({
      x: centerX + (pt.x - point.x) * zoomFactor,
      y: centerY + (pt.y - point.y) * zoomFactor,
    });

    // Draw border edges in the preview as curves
    const [tl, tr, br, bl] = this.state.corners;
    const mids = this.state.edgeMidpoints;

    type EdgeDef = { c1: Corner; mid: Corner[]; c2: Corner };
    const edgeDefs: EdgeDef[] = mids
      ? [
          { c1: tl, mid: mids[0], c2: tr },
          { c1: tr, mid: mids[1], c2: br },
          { c1: bl, mid: mids[2], c2: br },
          { c1: tl, mid: mids[3], c2: bl },
        ]
      : [
          { c1: tl, mid: [], c2: tr },
          { c1: tr, mid: [], c2: br },
          { c1: bl, mid: [], c2: br },
          { c1: tl, mid: [], c2: bl },
        ];

    // Determine which edges to draw based on what's being dragged
    const edgesToDraw = new Set<number>();
    if (this.state.draggingCornerIndex !== null) {
      const cornerEdgeMap: number[][] = [
        [0, 3],
        [0, 1],
        [1, 2],
        [2, 3],
      ];
      for (const e of cornerEdgeMap[this.state.draggingCornerIndex])
        edgesToDraw.add(e);
    } else if (this.state.draggingMidpointInfo !== null) {
      edgesToDraw.add(this.state.draggingMidpointInfo.edge);
    }

    const edgeLineWidth = Math.max(3, zoomSize * 0.01);
    const previewCurveSteps = 20;
    this.ctx.strokeStyle = "#3b82f6";
    this.ctx.lineWidth = edgeLineWidth;

    for (const edgeIdx of edgesToDraw) {
      const { c1, mid, c2 } = edgeDefs[edgeIdx];
      this.ctx.beginPath();
      for (let s = 0; s <= previewCurveSteps; s++) {
        const t = s / previewCurveSteps;
        const pt = evaluateEdge(c1, mid, c2, t);
        const pp = toPreview(pt);
        if (s === 0) this.ctx.moveTo(pp.x, pp.y);
        else this.ctx.lineTo(pp.x, pp.y);
      }
      this.ctx.stroke();
    }

    // Draw grid lines in the preview if grid is active
    if (this.state.showGrid) {
      const gridLineWidth = Math.max(1, zoomSize * 0.003);
      const gridSteps = 10;
      const hasPeaks =
        this.detectedColPositions.length > 0 &&
        this.detectedRowPositions.length > 0;

      this.ctx.strokeStyle = hasPeaks
        ? "rgba(59, 130, 246, 0.5)"
        : "rgba(148, 163, 184, 0.7)";
      this.ctx.lineWidth = hasPeaks ? gridLineWidth * 2 : gridLineWidth;

      this.ctx.beginPath();
      if (hasPeaks) {
        // Vertical centerlines through detected column positions
        for (const colPos of this.detectedColPositions) {
          for (let s = 0; s <= gridSteps; s++) {
            const row = (s / gridSteps) * this.state.outputHeight;
            const pt = this.transformPoint(colPos, row);
            if (pt) {
              const pp = toPreview(pt);
              if (s === 0) this.ctx.moveTo(pp.x, pp.y);
              else this.ctx.lineTo(pp.x, pp.y);
            }
          }
        }
        // Horizontal centerlines through detected row positions
        for (const rowPos of this.detectedRowPositions) {
          for (let s = 0; s <= gridSteps; s++) {
            const col = (s / gridSteps) * this.state.outputWidth;
            const pt = this.transformPoint(col, rowPos);
            if (pt) {
              const pp = toPreview(pt);
              if (s === 0) this.ctx.moveTo(pp.x, pp.y);
              else this.ctx.lineTo(pp.x, pp.y);
            }
          }
        }
      } else {
        // Fallback: boundary grid lines
        for (let col = 0; col <= this.state.outputWidth; col++) {
          for (let s = 0; s <= gridSteps; s++) {
            const row = (s / gridSteps) * this.state.outputHeight;
            const pt = this.transformPoint(col, row);
            if (pt) {
              const pp = toPreview(pt);
              if (s === 0) this.ctx.moveTo(pp.x, pp.y);
              else this.ctx.lineTo(pp.x, pp.y);
            }
          }
        }
        for (let row = 0; row <= this.state.outputHeight; row++) {
          for (let s = 0; s <= gridSteps; s++) {
            const col = (s / gridSteps) * this.state.outputWidth;
            const pt = this.transformPoint(col, row);
            if (pt) {
              const pp = toPreview(pt);
              if (s === 0) this.ctx.moveTo(pp.x, pp.y);
              else this.ctx.lineTo(pp.x, pp.y);
            }
          }
        }
      }
      this.ctx.stroke();
    }

    // Draw a dot at the point being dragged
    const dotRadius = Math.max(5, zoomSize * 0.015);
    const isCornerDrag = this.state.draggingCornerIndex !== null;
    this.ctx.fillStyle = isCornerDrag ? "#ef4444" : "#22c55e";
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, dotRadius, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.strokeStyle = "#ffffff";
    this.ctx.lineWidth = Math.max(2, zoomSize * 0.008);
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, dotRadius, 0, Math.PI * 2);
    this.ctx.stroke();

    this.ctx.restore();

    const fontSize = Math.max(14, zoomSize * 0.04);
    this.ctx.fillStyle = "#1e40af";
    this.ctx.font = `bold ${fontSize}px sans-serif`;
    this.ctx.fillText(
      `(${Math.round(point.x)}, ${Math.round(point.y)})`,
      previewX + fontSize * 0.5,
      previewY - fontSize * 0.7,
    );
  }

  private drawOutputCanvas() {
    if (
      !this.outputCanvas ||
      !this.outputCtx ||
      this.state.cellStates.length === 0
    )
      return;

    // Build or reuse the cached output layer
    if (this.outputCacheDirty || !this.outputCacheCanvas) {
      this.rebuildOutputCache();
    }

    if (!this.outputCacheCanvas) return;

    // Resize visible canvas to match cache
    if (
      this.outputCanvas.width !== this.outputCacheCanvas.width ||
      this.outputCanvas.height !== this.outputCacheCanvas.height
    ) {
      this.outputCanvas.width = this.outputCacheCanvas.width;
      this.outputCanvas.height = this.outputCacheCanvas.height;
    }

    // Blit cache
    this.outputCtx.drawImage(this.outputCacheCanvas, 0, 0);

    // Draw hover highlight on top and update coordinates display
    const hoverCoordsEl = document.getElementById("hover-coords");
    if (this.state.hoveredCell !== null) {
      const { row, col } = this.state.hoveredCell;
      const cellSize = this.outputCacheCellSize;
      this.outputCtx.fillStyle = "rgba(59, 130, 246, 0.4)";
      this.outputCtx.fillRect(
        col * cellSize,
        row * cellSize,
        cellSize,
        cellSize,
      );
      this.outputCtx.strokeStyle = "#3b82f6";
      this.outputCtx.lineWidth = 2;
      this.outputCtx.strokeRect(
        col * cellSize,
        row * cellSize,
        cellSize,
        cellSize,
      );
      if (hoverCoordsEl) {
        hoverCoordsEl.textContent = `(${col + 1}, ${this.state.outputHeight - row})`;
      }
    } else {
      if (hoverCoordsEl) {
        hoverCoordsEl.textContent = "";
      }
    }
  }

  private rebuildOutputCache() {
    if (!this.outputCanvas) return;

    // Get the container dimensions to scale appropriately
    const container = this.outputCanvas.parentElement;
    const maxWidth = container ? container.clientWidth - 40 : 400;
    const maxHeight = container ? container.clientHeight - 40 : 400;

    // Calculate cell size to fit within container while maintaining aspect ratio
    const cellSizeByWidth = maxWidth / this.state.outputWidth;
    const cellSizeByHeight = maxHeight / this.state.outputHeight;
    const cellSize = Math.max(
      2,
      Math.floor(Math.min(cellSizeByWidth, cellSizeByHeight)),
    );
    this.outputCacheCellSize = cellSize;

    const cacheW = this.state.outputWidth * cellSize;
    const cacheH = this.state.outputHeight * cellSize;

    // Create or resize offscreen canvas
    if (!this.outputCacheCanvas) {
      this.outputCacheCanvas = document.createElement("canvas");
      this.outputCacheCtx = this.outputCacheCanvas.getContext("2d");
    }
    this.outputCacheCanvas.width = cacheW;
    this.outputCacheCanvas.height = cacheH;
    const ctx = this.outputCacheCtx;
    if (!ctx) return;

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cacheW, cacheH);

    // Draw all black cells using ImageData for maximum speed
    const imageData = ctx.getImageData(0, 0, cacheW, cacheH);
    const pixels = imageData.data;
    for (let row = 0; row < this.state.outputHeight; row++) {
      for (let col = 0; col < this.state.outputWidth; col++) {
        if (this.state.cellStates[row]?.[col]) {
          const startX = col * cellSize;
          const startY = row * cellSize;
          for (let py = startY; py < startY + cellSize; py++) {
            const rowOffset = py * cacheW * 4;
            for (let px = startX; px < startX + cellSize; px++) {
              const idx = rowOffset + px * 4;
              pixels[idx] = 0; // R
              pixels[idx + 1] = 0; // G
              pixels[idx + 2] = 0; // B
              // Alpha is already 255 from getImageData
            }
          }
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // Draw grid lines in a single batched path
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let row = 0; row <= this.state.outputHeight; row++) {
      ctx.moveTo(0, row * cellSize);
      ctx.lineTo(cacheW, row * cellSize);
    }
    for (let col = 0; col <= this.state.outputWidth; col++) {
      ctx.moveTo(col * cellSize, 0);
      ctx.lineTo(col * cellSize, cacheH);
    }
    ctx.stroke();

    this.outputCacheDirty = false;
  }

  private exportAsPNG = () => {
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = this.state.outputWidth;
    exportCanvas.height = this.state.outputHeight;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;

    for (let row = 0; row < this.state.outputHeight; row++) {
      for (let col = 0; col < this.state.outputWidth; col++) {
        ctx.fillStyle = this.state.cellStates[row]?.[col]
          ? "#000000"
          : "#ffffff";
        ctx.fillRect(col, row, 1, 1);
      }
    }

    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "punchcard.png";
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  private exportAsBMP = () => {
    if (this.state.cellStates.length === 0) return;

    const width = this.state.outputWidth;
    const height = this.state.outputHeight;

    // BMP file format (24-bit RGB, uncompressed)
    const rowSize = Math.floor((width * 3 + 3) / 4) * 4; // Each row must be 4-byte aligned
    const pixelDataSize = rowSize * height;
    const fileSize = 54 + pixelDataSize; // Header (14) + InfoHeader (40) + Pixels

    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    // BMP Header (14 bytes)
    view.setUint8(0, 0x42); // 'B'
    view.setUint8(1, 0x4d); // 'M'
    view.setUint32(2, fileSize, true); // File size
    view.setUint32(6, 0, true); // Reserved
    view.setUint32(10, 54, true); // Offset to pixel data

    // DIB Header (BITMAPINFOHEADER - 40 bytes)
    view.setUint32(14, 40, true); // Header size
    view.setInt32(18, width, true); // Width
    view.setInt32(22, height, true); // Height (positive for bottom-up)
    view.setUint16(26, 1, true); // Planes
    view.setUint16(28, 24, true); // Bits per pixel (24-bit RGB)
    view.setUint32(30, 0, true); // Compression (none)
    view.setUint32(34, pixelDataSize, true); // Image size
    view.setInt32(38, 2835, true); // X pixels per meter (72 DPI)
    view.setInt32(42, 2835, true); // Y pixels per meter (72 DPI)
    view.setUint32(46, 0, true); // Colors used (0 = all)
    view.setUint32(50, 0, true); // Important colors (0 = all)

    // Pixel data (BGR format, bottom-up)
    let offset = 54;
    for (let row = height - 1; row >= 0; row--) {
      for (let col = 0; col < width; col++) {
        const isPunch = this.state.cellStates[row]?.[col];
        const color = isPunch ? 0 : 255; // Black (0) or White (255)

        // BMP uses BGR order
        view.setUint8(offset++, color); // B
        view.setUint8(offset++, color); // G
        view.setUint8(offset++, color); // R
      }

      // Padding to align to 4-byte boundary
      const bytesInRow = width * 3;
      const padding = rowSize - bytesInRow;
      for (let i = 0; i < padding; i++) {
        view.setUint8(offset++, 0);
      }
    }

    const blob = new Blob([buffer], { type: "image/bmp" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "punchcard.bmp";
    a.click();
    URL.revokeObjectURL(url);
  };

  private exportAsText = () => {
    let text = "";
    for (let row = 0; row < this.state.outputHeight; row++) {
      for (let col = 0; col < this.state.outputWidth; col++) {
        text += this.state.cellStates[row]?.[col] ? "1" : "0";
      }
      text += "\n";
    }

    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "punchcard.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  private render() {
    const template = html`
      <div class="min-h-screen bg-gray-50 flex flex-col">
        <!-- Toolbar -->
        <div class="bg-white border-b border-gray-200 px-4 py-3">
          <div class="max-w-7xl mx-auto">
            <h1 class="text-xl font-bold text-gray-900">Punchcard Digitizer</h1>
          </div>
        </div>

        <!-- Main Content -->
        <div class="flex-1 max-w-7xl mx-auto p-4 w-full">
                <div
                  class="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 h-full">
                  <!-- Input Image (Left) -->
                  <div
                    class="bg-white rounded-lg shadow overflow-hidden flex flex-col">
                    <div class="px-3 py-2 border-b border-gray-200 shrink-0">
                      <div class="flex items-start justify-between mb-2">
                        <div class="flex-1">
                          <div class="flex items-center gap-2 mb-1">
                            <h2 class="text-lg font-semibold text-gray-900">
                              Input Image
                            </h2>
                            <label class="cursor-pointer">
                              <input
                                type="file"
                                accept="image/*"
                                @change=${this.handleImageUpload}
                                class="hidden" />
                              <span
                                class="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded border border-gray-300 text-gray-700 bg-white hover:bg-gray-50">
                                ${this.state.uploadedImage ? "Change" : "Upload"}
                              </span>
                            </label>
                          </div>
                          <p class="text-xs text-gray-600">
                            ${
                              !this.state.uploadedImage
                                ? "Upload an image to get started"
                                : this.state.corners
                                  ? "Drag handles to correct perspective. Scroll to zoom, middle-click to pan."
                                  : "Drag to select the punchcard area. Scroll to zoom, middle-click to pan."
                            }
                          </p>
                        </div>
                        <div class="flex gap-1.5">
                          <button
                            @click=${this.autoDetect}
                            ?disabled=${!this.state.corners}
                            class="px-2.5 py-1 text-xs rounded whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-green-500 ${this.state.corners ? "bg-green-600 text-white hover:bg-green-700" : "bg-gray-100 text-gray-400 cursor-not-allowed"}">
                            Auto-Detect
                          </button>
                          <button
                            @click=${this.resetView}
                            ?disabled=${!this.state.uploadedImage}
                            class="px-2.5 py-1 text-xs rounded whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-blue-400 ${this.state.uploadedImage ? "bg-blue-100 text-blue-700 hover:bg-blue-200" : "bg-gray-100 text-gray-400 cursor-not-allowed"}">
                            Fit
                          </button>
                          <button
                            @click=${() => {
                              this.state.corners = null;
                              this.state.edgeMidpoints = null;
                              this.state.selectionBox = null;
                              this.state.showGrid = false;
                              this.state.cellStates = [];
                              this.detectedBlobs = [];
                              this.detectedColPositions = [];
                              this.detectedRowPositions = [];
                              this.render();
                            }}
                            ?disabled=${!this.state.corners}
                            class="px-2.5 py-1 text-xs rounded whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-gray-400 ${this.state.corners ? "bg-gray-200 text-gray-700 hover:bg-gray-300" : "bg-gray-100 text-gray-400 cursor-not-allowed"}">
                            Reset
                          </button>
                        </div>
                      </div>
                      <div class="flex gap-2 mb-2">
                        <div class="flex-1">
                          <label
                            class="block text-xs font-medium text-gray-700 mb-0.5">
                            Grid Width
                          </label>
                          <input
                            type="number"
                            .value=${this.state.outputWidth.toString()}
                            @input=${(e: Event) => {
                              this.state.outputWidth =
                                parseInt(
                                  (e.target as HTMLInputElement).value,
                                ) || 80;
                              if (this.state.showGrid) {
                                this.state.cellStates = Array(
                                  this.state.outputHeight,
                                )
                                  .fill(null)
                                  .map(() =>
                                    Array(this.state.outputWidth).fill(false),
                                  );
                                this.render();
                              }
                            }}
                            class="block w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                        </div>
                        <div class="flex-1">
                          <label
                            class="block text-xs font-medium text-gray-700 mb-0.5">
                            Grid Height
                          </label>
                          <input
                            type="number"
                            .value=${this.state.outputHeight.toString()}
                            @input=${(e: Event) => {
                              this.state.outputHeight =
                                parseInt(
                                  (e.target as HTMLInputElement).value,
                                ) || 12;
                              if (this.state.showGrid) {
                                this.state.cellStates = Array(
                                  this.state.outputHeight,
                                )
                                  .fill(null)
                                  .map(() =>
                                    Array(this.state.outputWidth).fill(false),
                                  );
                                this.render();
                              }
                            }}
                            class="block w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                        </div>
                        <div class="flex-1">
                          <label
                            class="block text-xs font-medium text-gray-700 mb-0.5">
                            Edge Pts
                          </label>
                          <input
                            type="number"
                            min="0"
                            max="5"
                            .value=${this.state.midpointsPerEdge.toString()}
                            @input=${(e: Event) => {
                              this.state.midpointsPerEdge = Math.max(
                                0,
                                Math.min(
                                  5,
                                  parseInt(
                                    (e.target as HTMLInputElement).value,
                                  ) || 0,
                                ),
                              );
                              if (this.state.corners) {
                                this.reinitMidpoints();
                                this.detectedBlobs = [];
                                this.detectedColPositions = [];
                                this.detectedRowPositions = [];
                                this.invalidateCaches();
                                this.render();
                              }
                            }}
                            class="block w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                        </div>
                      </div>
                      <div>
                        <label
                          class="block text-xs font-medium ${this.state.corners && this.state.showGrid ? "text-gray-700" : "text-gray-400"} mb-1">
                          Sensitivity:
                          ${this.state.detectionSensitivity}
                        </label>
                        <div class="flex items-center gap-2">
                          <span class="text-xs ${this.state.corners && this.state.showGrid ? "text-gray-500" : "text-gray-300"}">Low</span>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            .value=${this.state.detectionSensitivity.toString()}
                            ?disabled=${!(this.state.corners && this.state.showGrid)}
                            @input=${(e: Event) => {
                              this.state.detectionSensitivity = parseInt(
                                (e.target as HTMLInputElement).value,
                              );
                              if (this.thresholdDebounceTimer !== null) {
                                clearTimeout(this.thresholdDebounceTimer);
                              }
                              this.thresholdDebounceTimer = window.setTimeout(
                                () => {
                                  this.thresholdDebounceTimer = null;
                                  this.autoDetect();
                                },
                                30,
                              );
                            }}
                            class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600 disabled:opacity-40 disabled:cursor-not-allowed" />
                          <span class="text-xs ${this.state.corners && this.state.showGrid ? "text-gray-500" : "text-gray-300"}">High</span>
                        </div>
                      </div>
                      <div class="mt-1">
                        <label
                          class="block text-xs font-medium ${this.state.corners && this.state.showGrid ? "text-gray-700" : "text-gray-400"} mb-1">
                          Neighborhood:
                          ${this.state.neighborhoodRadius * 2 + 1}×${this.state.neighborhoodRadius * 2 + 1}
                        </label>
                        <div class="flex items-center gap-2">
                          <span class="text-xs ${this.state.corners && this.state.showGrid ? "text-gray-500" : "text-gray-300"}">Local</span>
                          <input
                            type="range"
                            min="1"
                            max="20"
                            .value=${this.state.neighborhoodRadius.toString()}
                            ?disabled=${!(this.state.corners && this.state.showGrid)}
                            @input=${(e: Event) => {
                              this.state.neighborhoodRadius = parseInt(
                                (e.target as HTMLInputElement).value,
                              );
                              if (this.thresholdDebounceTimer !== null) {
                                clearTimeout(this.thresholdDebounceTimer);
                              }
                              this.thresholdDebounceTimer = window.setTimeout(
                                () => {
                                  this.thresholdDebounceTimer = null;
                                  this.autoDetect();
                                },
                                30,
                              );
                            }}
                            class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600 disabled:opacity-40 disabled:cursor-not-allowed" />
                          <span class="text-xs ${this.state.corners && this.state.showGrid ? "text-gray-500" : "text-gray-300"}">Broad</span>
                        </div>
                      </div>
                      <div class="mt-1">
                        <label
                          class="block text-xs font-medium ${this.state.corners && this.state.showGrid ? "text-gray-700" : "text-gray-400"} mb-1">
                          Punch Size:
                          ${this.state.blobSizePercent}%
                        </label>
                        <div class="flex items-center gap-2">
                          <span class="text-xs ${this.state.corners && this.state.showGrid ? "text-gray-500" : "text-gray-300"}">Small</span>
                          <input
                            type="range"
                            min="5"
                            max="100"
                            .value=${this.state.blobSizePercent.toString()}
                            ?disabled=${!(this.state.corners && this.state.showGrid)}
                            @input=${(e: Event) => {
                              this.state.blobSizePercent = parseInt(
                                (e.target as HTMLInputElement).value,
                              );
                              if (this.thresholdDebounceTimer !== null) {
                                clearTimeout(this.thresholdDebounceTimer);
                              }
                              this.thresholdDebounceTimer = window.setTimeout(
                                () => {
                                  this.thresholdDebounceTimer = null;
                                  this.autoDetect();
                                },
                                30,
                              );
                            }}
                            class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600 disabled:opacity-40 disabled:cursor-not-allowed" />
                          <span class="text-xs ${this.state.corners && this.state.showGrid ? "text-gray-500" : "text-gray-300"}">Large</span>
                        </div>
                      </div>
                    </div>
                    <div class="flex-1 overflow-hidden flex flex-col">
                      ${
                        !this.state.uploadedImage
                          ? html`
                              <div
                                class="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-lg">
                                <svg
                                  class="h-10 w-10 text-gray-400 mb-3"
                                  stroke="currentColor"
                                  fill="none"
                                  viewBox="0 0 48 48">
                                  <path
                                    d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                                    stroke-width="2"
                                    stroke-linecap="round"
                                    stroke-linejoin="round" />
                                </svg>
                                <label class="cursor-pointer text-center">
                                  <span
                                    class="block text-sm font-medium text-gray-900 mb-1"
                                    >Upload a punchcard image</span
                                  >
                                  <span class="text-xs text-gray-500 block mb-3"
                                    >PNG, JPG, or other image formats</span
                                  >
                                  <input
                                    type="file"
                                    accept="image/*"
                                    @change=${this.handleImageUpload}
                                    class="hidden" />
                                  <span
                                    class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
                                    Choose File
                                  </span>
                                </label>
                              </div>
                            `
                          : html`
                              <div class="flex-1 overflow-hidden bg-gray-800">
                                <canvas
                                  id="punchcard-canvas"
                                  @mousedown=${this.handleMouseDown}
                                  @mousemove=${this.handleMouseMove}
                                  @mouseup=${this.handleMouseUp}
                                  @mouseleave=${this.handleMouseLeave}
                                  @contextmenu=${(e: Event) =>
                                    e.preventDefault()}
                                  class="w-full h-full cursor-crosshair"></canvas>
                              </div>
                            `
                      }
                    </div>
                  </div>

                  <div
                    class="bg-white rounded-lg shadow overflow-hidden flex flex-col">
                    <div
                      class="px-3 py-2 border-b border-gray-200 flex items-center justify-between shrink-0">
                      <div>
                        <h2 class="text-lg font-semibold text-gray-900">
                          Output Preview
                        </h2>
                        <p class="text-xs text-gray-600 mt-0.5">
                          ${
                            this.state.showGrid &&
                            this.state.cellStates.length > 0
                              ? `${this.state.outputWidth} × ${this.state.outputHeight} bitmap`
                              : "Select an area and click Auto-Detect"
                          }
                          <span
                            id="hover-coords"
                            class="ml-2 text-blue-600 font-medium"></span>
                        </p>
                      </div>
                      ${
                        this.state.showGrid && this.state.cellStates.length > 0
                          ? html`
                              <div class="flex gap-1.5 flex-wrap">
                                <button
                                  @click=${this.exportAsPNG}
                                  class="px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
                                  PNG
                                </button>
                                <button
                                  @click=${this.exportAsBMP}
                                  class="px-2.5 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500">
                                  BMP
                                </button>
                                <button
                                  @click=${this.exportAsText}
                                  class="px-2.5 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500">
                                  Text
                                </button>
                              </div>
                            `
                          : ""
                      }
                    </div>
                    <div class="flex-1 overflow-hidden flex flex-col">
                      <div
                        class="flex-1 overflow-auto flex items-center justify-center">
                        ${
                          this.state.showGrid &&
                          this.state.cellStates.length > 0
                            ? html`
                                <canvas
                                  id="output-canvas"
                                  @mousedown=${this.handleOutputMouseDown}
                                  @mousemove=${this.handleOutputMouseMove}
                                  @mouseleave=${this.handleOutputMouseLeave}
                                  class="border border-gray-300 rounded max-w-full max-h-full object-contain cursor-pointer"></canvas>
                              `
                            : html`
                                <div class="text-center text-gray-400 text-sm">
                                  No output yet
                                </div>
                              `
                        }
                      </div>
                    </div>
                  </div>
                </div>
              </div>
        </div>
      </div>
    `;

    render(template, this.container);

    // Setup canvas after render
    if (this.state.uploadedImage) {
      requestAnimationFrame(() => {
        this.setupCanvas();
      });
    }
  }

  private setupCanvas() {
    this.canvas = document.getElementById(
      "punchcard-canvas",
    ) as HTMLCanvasElement;
    if (!this.canvas || !this.state.uploadedImage) return;

    this.ctx = this.canvas.getContext("2d");
    this.canvas.width = this.state.uploadedImage.width;
    this.canvas.height = this.state.uploadedImage.height;

    // Attach wheel with passive: false so preventDefault works in all browsers
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });

    // Setup output canvas if it exists
    const outputCanvas = document.getElementById(
      "output-canvas",
    ) as HTMLCanvasElement;
    if (outputCanvas) {
      this.outputCanvas = outputCanvas;
      this.outputCtx = this.outputCanvas.getContext("2d");
    }

    this.invalidateCaches();
    this.drawCanvas();
    this.drawOutputCanvas();
  }
}

const app = document.getElementById("app");
if (app) {
  new PunchcardDigitizer(app);
}
