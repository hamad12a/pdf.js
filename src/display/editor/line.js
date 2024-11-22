import {
  AnnotationEditorParamsType,
  AnnotationEditorType,
  Util,
} from "../../shared/util.js";
import { AnnotationEditor } from "./editor.js";
import { LineAnnotationElement } from "../annotation_layer.js";
import { noContextMenu } from "../display_utils.js";
import { opacityToHex } from "./tools.js";

class LineEditor extends AnnotationEditor {
  #baseHeight = 0;
  #baseWidth = 0;
  #boundCanvasPointermove = this.canvasPointermove.bind(this);
  #boundCanvasPointerleave = this.canvasPointerleave.bind(this);
  #boundCanvasPointerup = this.canvasPointerup.bind(this);
  #boundCanvasPointerdown = this.canvasPointerdown.bind(this);
  #canvasContextMenuTimeoutId = null;
  #currentPath2D = new Path2D();
  #disableEditing = false;
  #hasSomethingToDraw = false;
  #isCanvasInitialized = false;
  #observer = null;
  #realWidth = 0;
  #realHeight = 0;
  #requestFrameCallback = null;
  static _defaultColor = null;
  static _defaultOpacity = 1;
  static _defaultThickness = 1;
  static _type = "line";
  static _editorType = AnnotationEditorType.LINE;

  static initialize(l10n, uiManager) {
    AnnotationEditor.initialize(l10n, uiManager);
  }

  static get defaultPropertiesToUpdate() {
    return [
      [AnnotationEditorParamsType.LINE_THICKNESS, LineEditor._defaultThickness],
      [
        AnnotationEditorParamsType.LINE_COLOR,
        LineEditor._defaultColor || AnnotationEditor._defaultLineColor,
      ],
      [
        AnnotationEditorParamsType.LINE_OPACITY,
        Math.round(LineEditor._defaultOpacity * 100),
      ],
    ];
  }

  canvasPointerup(event) {
    event.preventDefault();
    //begin #endDrawing
    this.canvas.removeEventListener("pointerleave", this.#boundCanvasPointerleave);
    this.canvas.removeEventListener("pointermove", this.#boundCanvasPointermove);
    this.canvas.removeEventListener("pointerup", this.#boundCanvasPointerup);
    this.canvas.addEventListener("pointerdown", this.#boundCanvasPointerdown, {
      signal: this._uiManager._signal,
    });

    // Slight delay to avoid the context menu to appear (it can happen on a long
    // tap with a pen).
    if (this.#canvasContextMenuTimeoutId) {
      clearTimeout(this.#canvasContextMenuTimeoutId);
    }
    this.#canvasContextMenuTimeoutId = setTimeout(() => {
      this.#canvasContextMenuTimeoutId = null;
      this.canvas.removeEventListener("contextmenu", noContextMenu);
    }, 10);

    this.#stopDrawing(event.offsetX, event.offsetY); // disabling this will disable stopdrawing and doesn't save the drawing!

    this.addToAnnotationStorage();

    // Since the ink editor covers all of the page and we want to be able
    // to select another editor, we just put this one in the background.
    this.setInBackground();
  }
  canvasPointermove(event) {
    event.preventDefault();
    this.#draw(event.offsetX, event.offsetY);
  }
  constructor(params) {
    super({ ...params, name: "lineEditor" });
    this.color = params.color || null;
    this.thickness = params.thickness || null;
    this.opacity = params.opacity || null;
    this.paths = [];
    this.bezierPath2D = [];
    this.allRawPaths = [];
    this.currentPath = [];
    this.scaleFactor = 1;
    this.translationX = this.translationY = 0;
    this.x = 0;
    this.y = 0;
    this._willKeepAspectRatio = true;
  }

  render() {
    if (this.div) {
      return this.div;
    }

    let baseX, baseY;
    if (this.width) {
      baseX = this.x;
      baseY = this.y;
    }

    super.render();

    this.div.setAttribute("data-l10n-id", "pdfjs-ink");
    //begin const [x,y,w,h] = this.#getInitialBBox
    const {
      parentRotation,
      parentDimensions: [width, height],
    } = this;
    
    let x, y, w, h;
    switch (parentRotation) {
      case 90:
        [x, y, w, h] = [0, height, height, width];
        break;
      case 180:
        [x, y, w, h] = [width, height, width, height];
        break;
      case 270:
        [x, y, w, h] = [width, 0, height, width];
        break;
      default:
        [x, y, w, h] = [0, 0, width, height];
        break;
    };
    this.setAt(x, y, 0, 0);
    this.setDims(w, h);

    this.#createCanvas();

    if (this.width) {
      // This editor was created in using copy (ctrl+c).
      const [parentWidth, parentHeight] = this.parentDimensions;
      this.setAspectRatio(this.width * parentWidth, this.height * parentHeight);
      this.setAt(
        baseX * parentWidth,
        baseY * parentHeight,
        this.width * parentWidth,
        this.height * parentHeight
      );
      this.#isCanvasInitialized = true;
      this.#setCanvasDims();
      this.setDims(this.width * parentWidth, this.height * parentHeight);
      this.#redraw();
      this.div.classList.add("disabled");
    } else {
      this.div.classList.add("editing");
      this.enableEditMode();
    }

    this.#createObserver();

    return this.div;
  }

  #createCanvas() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = 0;
    this.canvas.className = "lineEditorCanvas";
    this.canvas.setAttribute("data-l10n-id", "pdfjs-line-canvas");

    this.div.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
  }

  enableEditMode() {
    if (this.#disableEditing || this.canvas === null) {
      return;
    }

    super.enableEditMode();
    this._isDraggable = false;
    this.canvas.addEventListener("pointerdown", this.#boundCanvasPointerdown, {
      signal: this._uiManager._signal,
    });
  }

  #createObserver() {
    this.#observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      if (rect.width && rect.height) {
        this.setDimensions(rect.width, rect.height);
      }
    });
    this.#observer.observe(this.div);
    this._uiManager._signal.addEventListener(
      "abort",
      () => {
        this.#observer?.disconnect();
        this.#observer = null;
      },
      { once: true }
    );
  }

  onceAdded() {
    this._isDraggable = !this.isEmpty();
  }

  isEmpty() {
    return (
      this.paths.length === 0 ||
      (this.paths.length === 1 && this.paths[0].length === 0)
    );
  }

  setDimensions(width, height) {
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);
    if (
      this.#realWidth === roundedWidth &&
      this.#realHeight === roundedHeight
    ) {
      return;
    }

    this.#realWidth = roundedWidth;
    this.#realHeight = roundedHeight;

    this.canvas.style.visibility = "hidden";

    const [parentWidth, parentHeight] = this.parentDimensions;
    this.width = width / parentWidth;
    this.height = height / parentHeight;
    this.fixAndSetPosition();

    if (this.#disableEditing) {
      this.#setScaleFactor(width, height);
    }

    this.#setCanvasDims();
    this.#redraw();

    this.canvas.style.visibility = "visible";

    // For any reason the dimensions couldn't be in percent but in pixels, hence
    // we must fix them.
    this.fixDims();
  }

  #setCanvasDims() {
    if (!this.#isCanvasInitialized) {
      return;
    }
    const [parentWidth, parentHeight] = this.parentDimensions;
    this.canvas.width = Math.ceil(this.width * parentWidth);
    this.canvas.height = Math.ceil(this.height * parentHeight);
    this.#updateTransform();
  }

  #redraw() {
    if (this.isEmpty()) {
      this.#updateTransform();
      return;
    }
    //begin this.#setStroke();
    this.ctx.lineWidth = (this.thickness * this.parentScale) / this.scaleFactor;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.miterLimit = 10;
    this.ctx.strokeStyle = `${this.color}${opacityToHex(this.opacity)}`;
    // end of this.#setStroke();
    const { canvas, ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.#updateTransform();

    for (const path of this.bezierPath2D) {
      ctx.stroke(path);
    }
  }

  #updateTransform() {
    const padding = this.#getPadding() / 2;
    this.ctx.setTransform(
      this.scaleFactor,
      0,
      0,
      this.scaleFactor,
      this.translationX * this.scaleFactor + padding,
      this.translationY * this.scaleFactor + padding
    );
  }

  #getPadding() {
    return this.#disableEditing
      ? Math.ceil(this.thickness * this.parentScale)
      : 0;
  }

  canvasPointerdown(event) {
    if (event.button !== 0 || !this.isInEditMode() || this.#disableEditing) {
      return;
    }

    this.setInForeground();
    event.preventDefault();

    if (!this.div.contains(document.activeElement)) {
      this.div.focus({
        preventScroll: true /* See issue #17327 */,
      });
    }

    // this.#startDrawing(event.offsetX, event.offsetY);
    let x = event.offsetX;
    let y = event.offsetY;
    const signal = this._uiManager._signal;
    this.canvas.addEventListener("contextmenu", noContextMenu, { signal });
    this.canvas.addEventListener(
      "pointerleave",
      this.#boundCanvasPointerleave,
      { signal }
    );
    this.canvas.addEventListener("pointermove", this.#boundCanvasPointermove, {
      signal,
    });
    this.canvas.addEventListener("pointerup", this.#boundCanvasPointerup, {
      signal,
    });
    this.canvas.removeEventListener(
      "pointerdown",
      this.#boundCanvasPointerdown
    );

    this.isEditing = true;
    if (!this.#isCanvasInitialized) {
      this.#isCanvasInitialized = true;
      this.#setCanvasDims();
      this.thickness ||= LineEditor._defaultThickness;
      this.color ||=
        LineEditor._defaultColor || AnnotationEditor._defaultLineColor;
      this.opacity ??= LineEditor._defaultOpacity;
    }
    this.currentPath.push([x, y]);
    this.#hasSomethingToDraw = false;
    //begin this.#setStroke();
    this.ctx.lineWidth = (this.thickness * this.parentScale) / this.scaleFactor;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.miterLimit = 10;
    this.ctx.strokeStyle = `${this.color}${opacityToHex(this.opacity)}`;
    // end of this.#setStroke();

    this.#requestFrameCallback = () => {
      //begin this.#drawPoints();
      if (!this.#hasSomethingToDraw) {
      // Continue to the next condition
      } else {
      this.#hasSomethingToDraw = false;
      const thickness = Math.ceil(this.thickness * this.parentScale);
      const lastPoints = this.currentPath.slice(-3);
      const x = lastPoints.map(xy => xy[0]);
      const y = lastPoints.map(xy => xy[1]);
      const xMin = Math.min(...x) - thickness;
      const xMax = Math.max(...x) + thickness;
      const yMin = Math.min(...y) - thickness;
      const yMax = Math.max(...y) + thickness;
      const { ctx } = this;
      ctx.save();
      if (typeof PDFJSDev !== "undefined" && PDFJSDev.test("MOZCENTRAL")) {
        // In Chrome, the clip() method doesn't work as expected.
        ctx.clearRect(xMin, yMin, xMax - xMin, yMax - yMin);
        ctx.beginPath();
        ctx.rect(xMin, yMin, xMax - xMin, yMax - yMin);
        ctx.clip();
      } else {
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
      for (const path of this.bezierPath2D) {
        ctx.stroke(path); // this draws only what we see!
      }
      ctx.stroke(this.#currentPath2D); // this draws only what we don't see!
      ctx.restore();
      }
      // end of this.#drawPoints();
      if (this.#requestFrameCallback) {
      window.requestAnimationFrame(this.#requestFrameCallback);
      }
    };
    window.requestAnimationFrame(this.#requestFrameCallback);
    // end of #startDrawing(x, y)
  }

  get isResizable() {
    return !this.isEmpty() && this.#disableEditing;
  }

  get propertiesToUpdate() {
    return [
      [
        AnnotationEditorParamsType.LINE_THICKNESS,
        this.thickness || LineEditor._defaultThickness,
      ],
      [
        AnnotationEditorParamsType.LINE_COLOR,
        this.color ||
          LineEditor._defaultColor ||
          AnnotationEditor._defaultLineColor,
      ],
      [
        AnnotationEditorParamsType.LINE_OPACITY,
        Math.round(100 * (this.opacity ?? LineEditor._defaultOpacity)),
      ],
    ];
  }

  remove() {
    if (this.canvas === null) {
      return;
    }

    if (!this.isEmpty()) {
      this.commit();
    }

    // Destroy the canvas.
    this.canvas.width = this.canvas.height = 0;
    this.canvas.remove();
    this.canvas = null;

    if (this.#canvasContextMenuTimeoutId) {
      clearTimeout(this.#canvasContextMenuTimeoutId);
      this.#canvasContextMenuTimeoutId = null;
    }

    this.#observer?.disconnect();
    this.#observer = null;

    super.remove();
  }

  canvasPointerleave(event) {
    this.canvas.removeEventListener("pointerleave", this.#boundCanvasPointerleave);
    this.canvas.removeEventListener("pointermove", this.#boundCanvasPointermove);
    this.canvas.removeEventListener("pointerup", this.#boundCanvasPointerup);
    this.canvas.addEventListener("pointerdown", this.#boundCanvasPointerdown, {
      signal: this._uiManager._signal,
    });

    // Slight delay to avoid the context menu to appear (it can happen on a long
    // tap with a pen).
    if (this.#canvasContextMenuTimeoutId) {
      clearTimeout(this.#canvasContextMenuTimeoutId);
    }
    this.#canvasContextMenuTimeoutId = setTimeout(() => {
      this.#canvasContextMenuTimeoutId = null;
      this.canvas.removeEventListener("contextmenu", noContextMenu);
    }, 10);

    this.#stopDrawing(event.offsetX, event.offsetY); // disabling this will disable stopdrawing and doesn't save the drawing!

    this.addToAnnotationStorage();

    // Since the ink editor covers all of the page and we want to be able
    // to select another editor, we just put this one in the background.
    this.setInBackground();
  }

  #stopDrawing(x, y) {
    this.#requestFrameCallback = null;

    x = Math.min(Math.max(x, 0), this.canvas.width);
    y = Math.min(Math.max(y, 0), this.canvas.height);

    this.#draw(x, y);
    //begin this.#endPath();
    if (this.currentPath.length === 0) {
      return;
    }
    // const lastPoint = this.currentPath.at(-1);
    // this.#currentPath2D.lineTo(...this.currentPath.at(-1));
    // end of #endPath


    // const path = this.currentPath;

    let bezier = [[this.currentPath[0], this.currentPath[0], this.currentPath.at(-1), this.currentPath.at(-1)]];
    const path2D = this.#currentPath2D;
    const currentPath = this.currentPath;
    this.currentPath = [];
    this.#currentPath2D = new Path2D();

    const cmd = () => {
      this.allRawPaths.push(currentPath);
      this.paths.push(bezier);
      this.bezierPath2D.push(path2D);
      this._uiManager.rebuild(this);
    };

    const undo = () => {
      this.allRawPaths.pop();
      this.paths.pop();
      this.bezierPath2D.pop();
      if (this.paths.length === 0) {
        this.remove();
      } else {
        if (!this.canvas) {
          this.#createCanvas();
          this.#createObserver();
        }
        this.#fitToContent();
      }
    };

    this.addCommands({ cmd, undo, mustExec: true });
  }

  #draw(x, y) {
    const [firstX, firstY] = this.currentPath.at(0);
    const [lastX, lastY] = this.currentPath.at(-1);
    if (this.currentPath.length > 1 && x === lastX && y === lastY) {
      return;
    }
    this.currentPath.push([x, y]);
    this.#hasSomethingToDraw = true;
    this.#currentPath2D.moveTo(firstX, firstY);
    this.#currentPath2D.lineTo(x, y);
    
  }

  focusin(event) {
    if (!this._focusEventsAllowed) {
      return;
    }
    super.focusin(event);
    this.enableEditMode();
  }

  commit() {
    if (this.#disableEditing) {
      return;
    }

    super.commit();

    this.isEditing = false;
    this.disableEditMode();

    // This editor must be on top of the main ink editor.
    this.setInForeground();

    this.#disableEditing = true;
    this.div.classList.add("disabled");

    this.#fitToContent(/* firstTime = */ true);
    this.select();

    this.parent.addLineEditorIfNeeded(/* isCommitting = */ true);

    // When committing, the position of this editor is changed, hence we must
    // move it to the right position in the DOM.
    this.moveInDOM();
    this.div.focus({
      preventScroll: true /* See issue #15744 */,
    });
  }

  disableEditMode() {
    if (!this.isInEditMode() || this.canvas === null) {
      return;
    }

    super.disableEditMode();
    this._isDraggable = !this.isEmpty();
    this.div.classList.remove("editing");

    this.canvas.removeEventListener(
      "pointerdown",
      this.#boundCanvasPointerdown
    );
  }

  #fitToContent(firstTime = false) {
    if (this.isEmpty()) {
      return;
    }

    if (!this.#disableEditing) {
      this.#redraw();
      return;
    }

    const bbox = this.#getBbox();
    const padding = this.#getPadding();
    this.#baseWidth = Math.max(AnnotationEditor.MIN_SIZE, bbox[2] - bbox[0]);
    this.#baseHeight = Math.max(AnnotationEditor.MIN_SIZE, bbox[3] - bbox[1]);

    const width = Math.ceil(padding + this.#baseWidth * this.scaleFactor);
    const height = Math.ceil(padding + this.#baseHeight * this.scaleFactor);

    const [parentWidth, parentHeight] = this.parentDimensions;
    this.width = width / parentWidth;
    this.height = height / parentHeight;

    this.setAspectRatio(width, height);

    const prevTranslationX = this.translationX;
    const prevTranslationY = this.translationY;

    this.translationX = -bbox[0];
    this.translationY = -bbox[1];
    this.#setCanvasDims();
    this.#redraw();

    this.#realWidth = width;
    this.#realHeight = height;

    this.setDims(width, height);
    const unscaledPadding = firstTime ? padding / this.scaleFactor / 2 : 0;
    this.translate(
      prevTranslationX - this.translationX - unscaledPadding,
      prevTranslationY - this.translationY - unscaledPadding
    );
  }

  #getBbox() {
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;

    for (const path of this.paths) {
      for (const [first, control1, control2, second] of path) {
        const bbox = Util.bezierBoundingBox(
          ...first,
          ...control1,
          ...control2,
          ...second
        );
        xMin = Math.min(xMin, bbox[0]);
        yMin = Math.min(yMin, bbox[1]);
        xMax = Math.max(xMax, bbox[2]);
        yMax = Math.max(yMax, bbox[3]);
      }
    }

    return [xMin, yMin, xMax, yMax];
  }

  serialize() {
    if (this.isEmpty()) {
      return null;
    }

    const rect = this.getRect(0, 0);
    const color = AnnotationEditor._colorManager.convert(this.ctx.strokeStyle);

    return {
      annotationType: AnnotationEditorType.LINE,
      color,
      thickness: this.thickness,
      opacity: this.opacity,
      paths: this.#serializePaths(this.scaleFactor / this.parentScale,this.translationX,this.translationY,rect),
      pageIndex: this.pageIndex,
      rect,
      rotation: this.rotation,
      structTreeParentId: this._structTreeParentId,
    };
  }

  #serializePaths(s, tx, ty, rect) {
    const paths = [];
    const padding = this.thickness / 2;
    const shiftX = s * tx + padding;
    const shiftY = s * ty + padding;
    for (const bezier of this.paths) {
      const buffer = [];
      for (let j = 0, jj = bezier.length; j < jj; j++) {
        const [first, control1, control2, second] = bezier[j];

        const p10 = s * first[0] + shiftX;
        const p11 = s * first[1] + shiftY;
        const p20 = s * control1[0] + shiftX;
        const p21 = s * control1[1] + shiftY;
        const p30 = s * control2[0] + shiftX;
        const p31 = s * control2[1] + shiftY;
        const p40 = s * second[0] + shiftX;
        const p41 = s * second[1] + shiftY;

        if (j === 0) {
          buffer.push(p10, p11);
        }
        buffer.push(p20, p21, p30, p31, p40, p41);
      }
      paths.push({
        bezier: LineEditor.#toPDFCoordinates(buffer, rect, this.rotation),
      });
    }
    return paths;
  }

  static #toPDFCoordinates(points, rect, rotation) {
    const [blX, blY, trX, trY] = rect;

    switch (rotation) {
      case 0:
        for (let i = 0, ii = points.length; i < ii; i += 2) {
          points[i] += blX;
          points[i + 1] = trY - points[i + 1];
        }
        break;
      case 90:
        for (let i = 0, ii = points.length; i < ii; i += 2) {
          const x = points[i];
          points[i] = points[i + 1] + blX;
          points[i + 1] = x + blY;
        }
        break;
      case 180:
        for (let i = 0, ii = points.length; i < ii; i += 2) {
          points[i] = trX - points[i];
          points[i + 1] += blY;
        }
        break;
      case 270:
        for (let i = 0, ii = points.length; i < ii; i += 2) {
          const x = points[i];
          points[i] = trX - points[i + 1];
          points[i + 1] = trY - x;
        }
        break;
      default:
        throw new Error("Invalid rotation");
    }
    return points;
  }

  static deserialize(data, parent, uiManager) {
    if (data instanceof LineAnnotationElement) {
      return null;
    }
    const editor = super.deserialize(data, parent, uiManager);

    editor.thickness = data.thickness;
    editor.color = Util.makeHexColor(...data.color);
    editor.opacity = data.opacity;

    const [pageWidth, pageHeight] = editor.pageDimensions;
    const width = editor.width * pageWidth;
    const height = editor.height * pageHeight;
    const scaleFactor = editor.parentScale;
    const padding = data.thickness / 2;

    editor.#disableEditing = true;
    editor.#realWidth = Math.round(width);
    editor.#realHeight = Math.round(height);

    const { paths, rect, rotation } = data;

    for (let { bezier } of paths) {
      bezier = LineEditor.#fromPDFCoordinates(bezier, rect, rotation);
      const path = [];
      editor.paths.push(path);
      let p0 = scaleFactor * (bezier[0] - padding);
      let p1 = scaleFactor * (bezier[1] - padding);
      for (let i = 2, ii = bezier.length; i < ii; i += 6) {
        const p10 = scaleFactor * (bezier[i] - padding);
        const p11 = scaleFactor * (bezier[i + 1] - padding);
        const p20 = scaleFactor * (bezier[i + 2] - padding);
        const p21 = scaleFactor * (bezier[i + 3] - padding);
        const p30 = scaleFactor * (bezier[i + 4] - padding);
        const p31 = scaleFactor * (bezier[i + 5] - padding);
        path.push([
          [p0, p1],
          [p10, p11],
          [p20, p21],
          [p30, p31],
        ]);
        p0 = p30;
        p1 = p31;
      }
      //begin const path2D = this.#buildPath2D(path);
      const path2D = new Path2D();
      for (let i = 0, ii = path.length; i < ii; i++) {
        const [first, control1, control2, second] = path[i];
        if (i === 0) {
          path2D.moveTo(...first);
        }
        path2D.bezierCurveTo(
          control1[0],
          control1[1],
          control2[0],
          control2[1],
          second[0],
          second[1]
        );
      }
      // end of const path2D =

      editor.bezierPath2D.push(path2D);
    }

    const bbox = editor.#getBbox();
    editor.#baseWidth = Math.max(AnnotationEditor.MIN_SIZE, bbox[2] - bbox[0]);
    editor.#baseHeight = Math.max(AnnotationEditor.MIN_SIZE, bbox[3] - bbox[1]);
    editor.#setScaleFactor(width, height);

    return editor;
  }

  static #fromPDFCoordinates(points, rect, rotation) {
    const [blX, blY, trX, trY] = rect;

    switch (rotation) {
      case 0:
        for (let i = 0, ii = points.length; i < ii; i += 2) {
          points[i] -= blX;
          points[i + 1] = trY - points[i + 1];
        }
        break;
      case 90:
        for (let i = 0, ii = points.length; i < ii; i += 2) {
          const x = points[i];
          points[i] = points[i + 1] - blY;
          points[i + 1] = x - blX;
        }
        break;
      case 180:
        for (let i = 0, ii = points.length; i < ii; i += 2) {
          points[i] = trX - points[i];
          points[i + 1] -= blY;
        }
        break;
      case 270:
        for (let i = 0, ii = points.length; i < ii; i += 2) {
          const x = points[i];
          points[i] = trY - points[i + 1];
          points[i + 1] = trX - x;
        }
        break;
      default:
        throw new Error("Invalid rotation");
    }
    return points;
  }

  #setScaleFactor(width, height) {
    const padding = this.#getPadding();
    const scaleFactorW = (width - padding) / this.#baseWidth;
    const scaleFactorH = (height - padding) / this.#baseHeight;
    this.scaleFactor = Math.min(scaleFactorW, scaleFactorH);
  }

  static updateDefaultParams(type, value) {
    switch (type) {
      case AnnotationEditorParamsType.LINE_THICKNESS:
        LineEditor._defaultThickness = value;
        break;
      case AnnotationEditorParamsType.LINE_COLOR:
        LineEditor._defaultColor = value;
        break;
      case AnnotationEditorParamsType.LINE_OPACITY:
        LineEditor._defaultOpacity = value / 100;
        break;
    }
  }

  updateParams(type, value) {
    switch (type) {
      case AnnotationEditorParamsType.LINE_THICKNESS:
        const setThickness = th => {
          this.thickness = th;
          this.#fitToContent();
        };
        const savedThickness = this.thickness;
        this.addCommands({
          cmd: setThickness.bind(this, value),
          undo: setThickness.bind(this, savedThickness),
          post: this._uiManager.updateUI.bind(this._uiManager, this),
          mustExec: true,
          type: AnnotationEditorParamsType.LINE_THICKNESS,
          overwriteIfSameType: true,
          keepUndo: true,
        });
        break;
      case AnnotationEditorParamsType.LINE_COLOR:
        const setColor = col => {
          this.color = col;
          this.#redraw();
        };
        const savedColor = this.color;
        this.addCommands({
          cmd: setColor.bind(this, value),
          undo: setColor.bind(this, savedColor),
          post: this._uiManager.updateUI.bind(this._uiManager, this),
          mustExec: true,
          type: AnnotationEditorParamsType.LINE_COLOR,
          overwriteIfSameType: true,
          keepUndo: true,
        });
        break;
      case AnnotationEditorParamsType.LINE_OPACITY:
        const setOpacity = op => {
          this.opacity = op;
          this.#redraw();
        };
        value /= 100;
        const savedOpacity = this.opacity;
        this.addCommands({
          cmd: setOpacity.bind(this, value),
          undo: setOpacity.bind(this, savedOpacity),
          post: this._uiManager.updateUI.bind(this._uiManager, this),
          mustExec: true,
          type: AnnotationEditorParamsType.LINE_OPACITY,
          overwriteIfSameType: true,
          keepUndo: true,
        });
        break;
    }
  }

  rebuild() {
    if (!this.parent) {
      return;
    }
    super.rebuild();
    if (this.div === null) {
      return;
    }

    if (!this.canvas) {
      this.#createCanvas();
      this.#createObserver();
    }

    if (!this.isAttachedToDOM) {
      // At some point this editor was removed and we're rebuilding it,
      // hence we must add it to its parent.
      this.parent.add(this);
      this.#setCanvasDims();
    }
    this.#fitToContent();
  }

  setParent(parent) {
    if (!this.parent && parent) {
      // We've a parent hence the rescale will be handled thanks to the
      // ResizeObserver.
      this._uiManager.removeShouldRescale(this);
    } else if (this.parent && parent === null) {
      // The editor is removed from the DOM, hence we handle the rescale thanks
      // to the onScaleChanging callback.
      // This way, it'll be saved/printed correctly.
      this._uiManager.addShouldRescale(this);
    }
    super.setParent(parent);
  }

  onScaleChanging() {
    const [parentWidth, parentHeight] = this.parentDimensions;
    const width = this.width * parentWidth;
    const height = this.height * parentHeight;
    this.setDimensions(width, height);
  }

}

export { LineEditor };
