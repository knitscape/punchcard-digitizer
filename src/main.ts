import { html, render } from "lit-html";
import "./style.css";

interface Corner {
  x: number;
  y: number;
}

interface AppState {
  uploadedImage: HTMLImageElement | null;
  outputWidth: number;
  outputHeight: number;
  selectionBox: { x: number; y: number; width: number; height: number } | null;
  corners: [Corner, Corner, Corner, Corner] | null; // top-left, top-right, bottom-right, bottom-left
  isDragging: boolean;
  dragStart: { x: number; y: number } | null;
  draggingCornerIndex: number | null;
  cellStates: boolean[][];
  showGrid: boolean;
  detectionThreshold: number; // 0-255, pixels darker than this are considered punches
}

class PunchcardDigitizer {
  private state: AppState = {
    uploadedImage: null,
    outputWidth: 24,
    outputHeight: 52,
    selectionBox: null,
    corners: null,
    isDragging: false,
    dragStart: null,
    draggingCornerIndex: null,
    cellStates: [],
    showGrid: false,
    detectionThreshold: 128,
  };

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private outputCanvas: HTMLCanvasElement | null = null;
  private outputCtx: CanvasRenderingContext2D | null = null;

  constructor(private container: HTMLElement) {
    this.render();
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
        this.state.showGrid = false;
        this.state.cellStates = [];
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
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  private handleMouseDown = (e: MouseEvent) => {
    const coords = this.getCanvasCoords(e);
    if (!coords) return;

    // Check if clicking on a corner handle
    if (this.state.corners) {
      const cornerIndex = this.getCornerAtPoint(coords.x, coords.y);
      if (cornerIndex !== null) {
        this.state.draggingCornerIndex = cornerIndex;
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
      // Start dragging new selection box
      this.state.isDragging = true;
      this.state.dragStart = coords;
      this.state.showGrid = false;
    }
  };

  private handleMouseMove = (e: MouseEvent) => {
    const coords = this.getCanvasCoords(e);
    if (!coords) return;

    // Change cursor when hovering over corners
    if (
      this.state.corners &&
      !this.state.draggingCornerIndex &&
      !this.state.isDragging
    ) {
      const cornerIndex = this.getCornerAtPoint(coords.x, coords.y);
      if (this.canvas) {
        this.canvas.style.cursor = cornerIndex !== null ? "move" : "crosshair";
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
      this.drawCanvas();
      return;
    }

    // Handle selection box dragging
    if (!this.state.isDragging || !this.state.dragStart) return;

    const x = Math.min(this.state.dragStart.x, coords.x);
    const y = Math.min(this.state.dragStart.y, coords.y);
    const width = Math.abs(coords.x - this.state.dragStart.x);
    const height = Math.abs(coords.y - this.state.dragStart.y);

    this.state.selectionBox = { x, y, width, height };
    this.drawCanvas();
  };

  private handleMouseUp = () => {
    // Reset cursor
    if (this.canvas) {
      this.canvas.style.cursor = "crosshair";
    }

    // Finish corner dragging
    if (this.state.draggingCornerIndex !== null) {
      this.state.draggingCornerIndex = null;
      // Redraw without the zoom preview
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
        // Initialize corners from selection box
        const { x, y, width, height } = this.state.selectionBox;
        this.state.corners = [
          { x, y }, // top-left
          { x: x + width, y }, // top-right
          { x: x + width, y: y + height }, // bottom-right
          { x, y: y + height }, // bottom-left
        ];
        this.render();
      }
    }
  };

  private getCornerAtPoint(x: number, y: number): number | null {
    if (!this.state.corners) return null;

    const handleRadius = 50; // Larger hit area for easier clicking
    for (let i = 0; i < 4; i++) {
      const corner = this.state.corners[i];
      const distance = Math.sqrt(
        Math.pow(x - corner.x, 2) + Math.pow(y - corner.y, 2),
      );
      if (distance <= handleRadius) {
        return i;
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
    this.drawCanvas();
    this.drawOutputCanvas();
  }

  // Bilinear interpolation for quadrilateral transformation
  // col should be in range [0, outputWidth], row in range [0, outputHeight]
  private transformPoint(col: number, row: number): Corner | null {
    if (!this.state.corners) return null;

    // Normalize to [0, 1] range
    const u = col / this.state.outputWidth;
    const v = row / this.state.outputHeight;

    const [tl, tr, br, bl] = this.state.corners;

    // Bilinear interpolation
    const x =
      (1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x);

    const y =
      (1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y);

    return { x, y };
  }

  private inverseTransformPoint(
    x: number,
    y: number,
  ): { x: number; y: number } | null {
    if (!this.state.corners) return null;

    // Use iterative approach to find (col, row) that maps to (x, y)
    // For simplicity, use bilinear interpolation approximation
    const [tl, tr, br, bl] = this.state.corners;

    // Bilinear inverse (approximate)
    // Find u, v such that the bilinear interpolation gives (x, y)
    let u = 0.5,
      v = 0.5;
    for (let iter = 0; iter < 10; iter++) {
      const px =
        (1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x);
      const py =
        (1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y);

      const dx = x - px;
      const dy = y - py;

      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;

      const du = 0.01;
      const dv = 0.01;

      const px_u =
        (1 - v) * ((1 - (u + du)) * tl.x + (u + du) * tr.x) +
        v * ((1 - (u + du)) * bl.x + (u + du) * br.x);
      const py_u =
        (1 - v) * ((1 - (u + du)) * tl.y + (u + du) * tr.y) +
        v * ((1 - (u + du)) * bl.y + (u + du) * br.y);
      const px_v =
        (1 - (v + dv)) * ((1 - u) * tl.x + u * tr.x) +
        (v + dv) * ((1 - u) * bl.x + u * br.x);
      const py_v =
        (1 - (v + dv)) * ((1 - u) * tl.y + u * tr.y) +
        (v + dv) * ((1 - u) * bl.y + u * br.y);

      const grad_u_x = (px_u - px) / du;
      const grad_u_y = (py_u - py) / du;
      const grad_v_x = (px_v - px) / dv;
      const grad_v_y = (py_v - py) / dv;

      const det = grad_u_x * grad_v_y - grad_u_y * grad_v_x;
      if (Math.abs(det) < 0.0001) break;

      const du_step = (grad_v_y * dx - grad_v_x * dy) / det;
      const dv_step = (-grad_u_y * dx + grad_u_x * dy) / det;

      u += du_step * 0.5;
      v += dv_step * 0.5;

      u = Math.max(0, Math.min(1, u));
      v = Math.max(0, Math.min(1, v));
    }

    return {
      x: u * this.state.outputWidth,
      y: v * this.state.outputHeight,
    };
  }

  private autoDetect = () => {
    if (
      !this.state.uploadedImage ||
      !this.state.corners ||
      !this.canvas ||
      !this.ctx
    )
      return;

    // Initialize grid if not already done
    if (!this.state.showGrid) {
      this.state.showGrid = true;
      this.state.cellStates = Array(this.state.outputHeight)
        .fill(null)
        .map(() => Array(this.state.outputWidth).fill(false));
    }

    // Get full canvas image data
    const fullImageData = this.ctx.getImageData(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
    const data = fullImageData.data;

    // Analyze each cell using perspective transform
    for (let row = 0; row < this.state.outputHeight; row++) {
      for (let col = 0; col < this.state.outputWidth; col++) {
        let totalLightness = 0;
        let pixelCount = 0;

        // Sample multiple points within the cell
        const samples = 5;
        for (let sy = 0; sy < samples; sy++) {
          for (let sx = 0; sx < samples; sx++) {
            const u = col + (sx + 0.5) / samples;
            const v = row + (sy + 0.5) / samples;

            const point = this.transformPoint(u, v);
            if (!point) continue;

            const px = Math.floor(point.x);
            const py = Math.floor(point.y);

            if (
              px >= 0 &&
              px < this.canvas.width &&
              py >= 0 &&
              py < this.canvas.height
            ) {
              const idx = (py * this.canvas.width + px) * 4;
              const r = data[idx];
              const g = data[idx + 1];
              const b = data[idx + 2];
              const lightness = (r + g + b) / 3;
              totalLightness += lightness;
              pixelCount++;
            }
          }
        }

        if (pixelCount > 0) {
          const avgLightness = totalLightness / pixelCount;
          // If dark (punch is black), mark as true based on threshold
          this.state.cellStates[row][col] = avgLightness < this.state.detectionThreshold;
        }
      }
    }

    this.render();
  };

  private drawCanvas() {
    if (!this.canvas || !this.ctx || !this.state.uploadedImage) return;

    // Clear and draw image
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(
      this.state.uploadedImage,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );

    // Draw corners and grid if available
    if (this.state.corners) {
      const [tl, tr, br, bl] = this.state.corners;

      // Draw border connecting corners with thicker line
      this.ctx.strokeStyle = "#3b82f6";
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.moveTo(tl.x, tl.y);
      this.ctx.lineTo(tr.x, tr.y);
      this.ctx.lineTo(br.x, br.y);
      this.ctx.lineTo(bl.x, bl.y);
      this.ctx.closePath();
      this.ctx.stroke();

      // Draw semi-transparent fill to show selected area
      this.ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
      this.ctx.fill();

      // Draw perspective-corrected grid if enabled
      if (this.state.showGrid) {
        this.ctx.strokeStyle = "#94a3b8";
        this.ctx.lineWidth = 0.5;

        // Calculate grid step to avoid drawing too many lines
        const maxGridLines = 20;
        const colStep = Math.max(
          1,
          Math.ceil(this.state.outputWidth / maxGridLines),
        );
        const rowStep = Math.max(
          1,
          Math.ceil(this.state.outputHeight / maxGridLines),
        );

        // Draw vertical grid lines (draw every colStep lines)
        for (let col = 0; col <= this.state.outputWidth; col += colStep) {
          this.ctx.beginPath();
          const topPoint = this.transformPoint(col, 0);
          const bottomPoint = this.transformPoint(col, this.state.outputHeight);
          if (topPoint && bottomPoint) {
            this.ctx.moveTo(topPoint.x, topPoint.y);
            this.ctx.lineTo(bottomPoint.x, bottomPoint.y);
            this.ctx.stroke();
          }
        }
        // Always draw the last vertical line
        if (this.state.outputWidth % colStep !== 0) {
          this.ctx.beginPath();
          const topPoint = this.transformPoint(this.state.outputWidth, 0);
          const bottomPoint = this.transformPoint(
            this.state.outputWidth,
            this.state.outputHeight,
          );
          if (topPoint && bottomPoint) {
            this.ctx.moveTo(topPoint.x, topPoint.y);
            this.ctx.lineTo(bottomPoint.x, bottomPoint.y);
            this.ctx.stroke();
          }
        }

        // Draw horizontal grid lines (draw every rowStep lines)
        for (let row = 0; row <= this.state.outputHeight; row += rowStep) {
          this.ctx.beginPath();
          const leftPoint = this.transformPoint(0, row);
          const rightPoint = this.transformPoint(this.state.outputWidth, row);
          if (leftPoint && rightPoint) {
            this.ctx.moveTo(leftPoint.x, leftPoint.y);
            this.ctx.lineTo(rightPoint.x, rightPoint.y);
            this.ctx.stroke();
          }
        }
        // Always draw the last horizontal line
        if (this.state.outputHeight % rowStep !== 0) {
          this.ctx.beginPath();
          const leftPoint = this.transformPoint(0, this.state.outputHeight);
          const rightPoint = this.transformPoint(
            this.state.outputWidth,
            this.state.outputHeight,
          );
          if (leftPoint && rightPoint) {
            this.ctx.moveTo(leftPoint.x, leftPoint.y);
            this.ctx.lineTo(rightPoint.x, rightPoint.y);
            this.ctx.stroke();
          }
        }

        // Fill marked cells
        for (let row = 0; row < this.state.outputHeight; row++) {
          for (let col = 0; col < this.state.outputWidth; col++) {
            if (this.state.cellStates[row]?.[col]) {
              const corners = [
                this.transformPoint(col, row),
                this.transformPoint(col + 1, row),
                this.transformPoint(col + 1, row + 1),
                this.transformPoint(col, row + 1),
              ];
              if (corners.every((c) => c !== null)) {
                this.ctx.fillStyle = "rgba(239, 68, 68, 0.5)";
                this.ctx.beginPath();
                this.ctx.moveTo(corners[0]!.x, corners[0]!.y);
                this.ctx.lineTo(corners[1]!.x, corners[1]!.y);
                this.ctx.lineTo(corners[2]!.x, corners[2]!.y);
                this.ctx.lineTo(corners[3]!.x, corners[3]!.y);
                this.ctx.closePath();
                this.ctx.fill();
              }
            }
          }
        }
      }

      // Draw corner handles (large for easy clicking)
      const handleRadius = 30;
      for (let i = 0; i < 4; i++) {
        const corner = this.state.corners[i];

        // Draw outer circle (white border)
        this.ctx.fillStyle = "#ffffff";
        this.ctx.beginPath();
        this.ctx.arc(corner.x, corner.y, handleRadius, 0, Math.PI * 2);
        this.ctx.fill();

        // Draw inner circle (blue)
        this.ctx.fillStyle = "#3b82f6";
        this.ctx.beginPath();
        this.ctx.arc(corner.x, corner.y, handleRadius - 5, 0, Math.PI * 2);
        this.ctx.fill();

        // Draw thick border
        this.ctx.strokeStyle = "#1e40af";
        this.ctx.lineWidth = 5;
        this.ctx.beginPath();
        this.ctx.arc(corner.x, corner.y, handleRadius, 0, Math.PI * 2);
        this.ctx.stroke();
      }
    }

    // Draw zoom preview if dragging a corner
    if (this.state.draggingCornerIndex !== null && this.state.corners) {
      this.drawZoomPreview(
        this.state.corners[this.state.draggingCornerIndex],
        this.state.draggingCornerIndex,
      );
    }

    // Draw selection box while dragging (before corners are created)
    if (this.state.isDragging && this.state.selectionBox) {
      const { x, y, width, height } = this.state.selectionBox;

      // Draw semi-transparent fill
      this.ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
      this.ctx.fillRect(x, y, width, height);

      // Draw border
      this.ctx.strokeStyle = "#3b82f6";
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(x, y, width, height);
    }

    // Draw output canvas
    this.drawOutputCanvas();
  }

  private drawZoomPreview(corner: Corner, cornerIndex: number) {
    if (
      !this.canvas ||
      !this.ctx ||
      !this.state.uploadedImage ||
      !this.state.corners
    )
      return;

    // Make zoom window proportional to canvas size for consistent appearance
    // Use 30% of the smaller canvas dimension to ensure it's always visible
    const zoomSize = Math.min(this.canvas.width, this.canvas.height) * 0.3;
    const zoomFactor = 5; // 5x magnification
    const sourceSize = zoomSize / zoomFactor;

    // Position the zoom window offset from the corner (to avoid obscuring)
    const offset = zoomSize * 0.2; // Offset proportional to zoom size
    let previewX = corner.x + offset;
    let previewY = corner.y + offset;

    // Keep the preview on screen
    if (previewX + zoomSize > this.canvas.width) {
      previewX = corner.x - zoomSize - offset;
    }
    if (previewY + zoomSize > this.canvas.height) {
      previewY = corner.y - zoomSize - offset;
    }
    if (previewX < 0) previewX = zoomSize * 0.02;
    if (previewY < 0) previewY = zoomSize * 0.02;

    // Draw white border/background (border thickness proportional to zoom size)
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

    // Calculate source region from the ORIGINAL IMAGE (not the canvas)
    // Convert canvas coordinates to image coordinates
    const scaleX = this.state.uploadedImage.width / this.canvas.width;
    const scaleY = this.state.uploadedImage.height / this.canvas.height;

    const imgCornerX = corner.x * scaleX;
    const imgCornerY = corner.y * scaleY;
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

    // Save context state and clip to preview area
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(previewX, previewY, zoomSize, zoomSize);
    this.ctx.clip();

    // Draw zoomed section from the ORIGINAL IMAGE
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

    // Calculate center of zoom window (where the corner is)
    const centerX = previewX + zoomSize / 2;
    const centerY = previewY + zoomSize / 2;

    // Helper function to transform a canvas point to zoom preview coordinates
    const toPreviewCoords = (pt: Corner) => {
      const offsetX = pt.x - corner.x;
      const offsetY = pt.y - corner.y;
      return {
        x: centerX + offsetX * zoomFactor,
        y: centerY + offsetY * zoomFactor,
      };
    };

    // Get the two adjacent corners to draw the corner edges
    // Corners are ordered: [top-left, top-right, bottom-right, bottom-left]
    const prevCornerIndex = (cornerIndex - 1 + 4) % 4;
    const nextCornerIndex = (cornerIndex + 1) % 4;

    const prevCorner = toPreviewCoords(this.state.corners[prevCornerIndex]);
    const currCorner = { x: centerX, y: centerY };
    const nextCorner = toPreviewCoords(this.state.corners[nextCornerIndex]);

    // Draw the two edges that meet at this corner (clipped to preview)
    const edgeLineWidth = Math.max(3, zoomSize * 0.01);
    this.ctx.strokeStyle = "#3b82f6";
    this.ctx.lineWidth = edgeLineWidth;

    // First edge
    this.ctx.beginPath();
    this.ctx.moveTo(prevCorner.x, prevCorner.y);
    this.ctx.lineTo(currCorner.x, currCorner.y);
    this.ctx.stroke();

    // Second edge
    this.ctx.beginPath();
    this.ctx.moveTo(currCorner.x, currCorner.y);
    this.ctx.lineTo(nextCorner.x, nextCorner.y);
    this.ctx.stroke();

    // Draw circle at the corner position (proportional to zoom size)
    const dotRadius = Math.max(5, zoomSize * 0.015);
    this.ctx.fillStyle = "#ef4444";
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, dotRadius, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.strokeStyle = "#ffffff";
    this.ctx.lineWidth = Math.max(2, zoomSize * 0.008);
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, dotRadius, 0, Math.PI * 2);
    this.ctx.stroke();

    // Restore context state (removes clipping)
    this.ctx.restore();

    // Draw corner position label (proportional font size)
    const fontSize = Math.max(14, zoomSize * 0.04);
    this.ctx.fillStyle = "#1e40af";
    this.ctx.font = `bold ${fontSize}px sans-serif`;
    this.ctx.fillText(
      `(${Math.round(corner.x)}, ${Math.round(corner.y)})`,
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

    // Get the container dimensions to scale appropriately
    const container = this.outputCanvas.parentElement;
    const maxWidth = container ? container.clientWidth - 40 : 400;
    const maxHeight = container ? container.clientHeight - 40 : 400;

    // Calculate cell size to fit within container while maintaining aspect ratio
    const cellSizeByWidth = maxWidth / this.state.outputWidth;
    const cellSizeByHeight = maxHeight / this.state.outputHeight;
    const cellSize = Math.max(2, Math.floor(Math.min(cellSizeByWidth, cellSizeByHeight)));

    this.outputCanvas.width = this.state.outputWidth * cellSize;
    this.outputCanvas.height = this.state.outputHeight * cellSize;

    // Clear canvas
    this.outputCtx.fillStyle = "#ffffff";
    this.outputCtx.fillRect(
      0,
      0,
      this.outputCanvas.width,
      this.outputCanvas.height,
    );

    // Draw cells
    for (let row = 0; row < this.state.outputHeight; row++) {
      for (let col = 0; col < this.state.outputWidth; col++) {
        if (this.state.cellStates[row]?.[col]) {
          this.outputCtx.fillStyle = "#000000";
          this.outputCtx.fillRect(
            col * cellSize,
            row * cellSize,
            cellSize,
            cellSize,
          );
        }
      }
    }

    // Draw grid lines
    this.outputCtx.strokeStyle = "#e5e7eb";
    this.outputCtx.lineWidth = 1;
    for (let row = 0; row <= this.state.outputHeight; row++) {
      this.outputCtx.beginPath();
      this.outputCtx.moveTo(0, row * cellSize);
      this.outputCtx.lineTo(this.state.outputWidth * cellSize, row * cellSize);
      this.outputCtx.stroke();
    }
    for (let col = 0; col <= this.state.outputWidth; col++) {
      this.outputCtx.beginPath();
      this.outputCtx.moveTo(col * cellSize, 0);
      this.outputCtx.lineTo(col * cellSize, this.state.outputHeight * cellSize);
      this.outputCtx.stroke();
    }
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
          ${!this.state.uploadedImage
            ? html`
                <!-- Initial Upload State -->
                <div
                  class="bg-white rounded-lg shadow overflow-hidden h-full flex flex-col">
                  <div class="p-4 flex-1 flex flex-col">
                    <h2 class="text-lg font-semibold text-gray-900 mb-3">
                      Input Image
                    </h2>
                    <div
                      class="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center flex-1 flex flex-col items-center justify-center">
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
                      <label class="cursor-pointer">
                        <span
                          class="block text-sm font-medium text-gray-900 mb-1">
                          Upload a punchcard image
                        </span>
                        <span class="text-xs text-gray-500 block mb-3">
                          PNG, JPG, or other image formats
                        </span>
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
                  </div>
                </div>
              `
            : html`
                <!-- Image Loaded State -->
                <div class="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 h-full">
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
                                Change
                              </span>
                            </label>
                          </div>
                          <p class="text-xs text-gray-600">
                            ${this.state.corners
                              ? "Drag corner handles to correct perspective"
                              : "Drag to select the punchcard area"}
                          </p>
                        </div>
                        ${this.state.corners
                          ? html`
                              <div class="flex gap-1.5">
                                <button
                                  @click=${this.autoDetect}
                                  class="px-2.5 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 whitespace-nowrap">
                                  Auto-Detect
                                </button>
                                <button
                                  @click=${() => {
                                    this.state.corners = null;
                                    this.state.selectionBox = null;
                                    this.state.showGrid = false;
                                    this.state.cellStates = [];
                                    this.render();
                                  }}
                                  class="px-2.5 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-400 whitespace-nowrap">
                                  Reset
                                </button>
                              </div>
                            `
                          : ""}
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
                      </div>
                      ${this.state.corners && this.state.showGrid
                        ? html`
                            <div>
                              <label class="block text-xs font-medium text-gray-700 mb-1">
                                Detection Threshold: ${this.state.detectionThreshold}
                              </label>
                              <div class="flex items-center gap-2">
                                <span class="text-xs text-gray-500">Light</span>
                                <input
                                  type="range"
                                  min="0"
                                  max="255"
                                  .value=${this.state.detectionThreshold.toString()}
                                  @input=${(e: Event) => {
                                    this.state.detectionThreshold = parseInt(
                                      (e.target as HTMLInputElement).value,
                                    );
                                    // Re-run detection with new threshold
                                    this.autoDetect();
                                  }}
                                  class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
                                <span class="text-xs text-gray-500">Dark</span>
                              </div>
                            </div>
                          `
                        : ''}
                    </div>
                    <div class="p-3 flex-1 overflow-hidden flex flex-col">
                      <div class="flex-1 overflow-auto">
                        <canvas
                          id="punchcard-canvas"
                          @mousedown=${this.handleMouseDown}
                          @mousemove=${this.handleMouseMove}
                          @mouseup=${this.handleMouseUp}
                          @mouseleave=${this.handleMouseUp}
                          class="max-w-full border border-gray-300 rounded cursor-crosshair"></canvas>
                      </div>
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
                          ${this.state.showGrid &&
                          this.state.cellStates.length > 0
                            ? `${this.state.outputWidth} × ${this.state.outputHeight} bitmap`
                            : "Select an area and click Auto-Detect"}
                        </p>
                      </div>
                      ${this.state.showGrid && this.state.cellStates.length > 0
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
                        : ""}
                    </div>
                    <div class="p-3 flex-1 overflow-hidden flex flex-col">
                      <div
                        class="flex-1 overflow-auto flex items-center justify-center">
                        ${this.state.showGrid &&
                        this.state.cellStates.length > 0
                          ? html`
                              <canvas
                                id="output-canvas"
                                class="border border-gray-300 rounded max-w-full max-h-full object-contain"></canvas>
                            `
                          : html`
                              <div class="text-center text-gray-400 text-sm">
                                No output yet
                              </div>
                            `}
                      </div>
                    </div>
                  </div>
                </div>
              `}
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

    // Setup output canvas if it exists
    const outputCanvas = document.getElementById(
      "output-canvas",
    ) as HTMLCanvasElement;
    if (outputCanvas) {
      this.outputCanvas = outputCanvas;
      this.outputCtx = this.outputCanvas.getContext("2d");
    }

    this.drawCanvas();
  }
}

const app = document.getElementById("app");
if (app) {
  new PunchcardDigitizer(app);
}
