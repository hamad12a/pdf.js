import {
  AnnotationEditorParamsType,
  AnnotationEditorType,
  Util,
} from "../../shared/util.js";
import { AnnotationEditor } from "./editor.js";
import { SquareAnnotationElement } from "../annotation_layer.js";
import { noContextMenu } from "../display_utils.js";
import { opacityToHex } from "./tools.js";

class SquareEditor extends AnnotationEditor {
  #baseHeight = 0;
  #baseWidth = 0;
  #boundCanvasPointermove = this.canvasPointermove.bind(this);
  #boundCanvasPointerleave = this.canvasPointerleave.bind(this);
  #boundCanvasPointerup = this.canvasPointerup.bind(this);
  #boundCanvasPointerdown = this.canvasPointerdown.bind(this);
  #canvasContextMenuTimeoutId = null;
  #currentPath2D = null;
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
  static _type = "square";
  static _editorType = AnnotationEditorType.SQUARE;

  static initialize(l10n, uiManager) {
    AnnotationEditor.initialize(l10n, uiManager);
  }

  canvasPointerup(event) {
    event.preventDefault();
    this.canvas.removeEventListener(
      "pointerleave",
      this.#boundCanvasPointerleave
    );
    this.canvas.removeEventListener(
      "pointermove",
      this.#boundCanvasPointermove
    );
    this.canvas.removeEventListener("pointerup", this.#boundCanvasPointerup);
    this.canvas.addEventListener("pointerdown", this.#boundCanvasPointerdown, {
      signal: this._uiManager._signal,
    });

    if (this.#canvasContextMenuTimeoutId) {
      clearTimeout(this.#canvasContextMenuTimeoutId);
    }
    this.#canvasContextMenuTimeoutId = setTimeout(() => {
      this.#canvasContextMenuTimeoutId = null;
      this.canvas.removeEventListener("contextmenu", noContextMenu);
    }, 10);

    this.#stopDrawing(event.offsetX, event.offsetY);

    this.addToAnnotationStorage();
    this.setInBackground();
  }

  canvasPointermove(event) {
    event.preventDefault();
    if (this.isResizing) {
      //begin this.resizeRectangle(event.offsetX, event.offsetY);
      const currentRect = this.selectedRectangle; // This should be set when a resizer is grabbed
      if (currentRect) {
        currentRect.width = mouseX - currentRect.startX;
        currentRect.height = mouseY - currentRect.startY;
        this.#redraw();
      }
      // end
    } else {
      this.#draw(event.offsetX, event.offsetY);
    }
  }

  constructor(params) {
    super({ ...params, name: "squareEditor" });
    this.color = params.color || null;
    this.thickness = params.thickness || null;
    this.opacity = params.opacity || null;
    this.currentPath = [];
    this.translationX = this.translationY = 0;
    this.x = 0;
    this.y = 0;
    this.rectangles = [];
    this.scaleFactor = 1;
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

    this.div.setAttribute("data-l10n-id", "pdfjs-square");

    //begin const [x, y, w, h] = this.#getInitialBBox();
    const { parentRotation,parentDimensions: [width, height] } = this;
    let x, y, w, h;
    switch (parentRotation) {
      case 90:
        [x, y, w, h] = [0, height, height, width];
      case 180:
        [x, y, w, h] = [width, height, width, height];
      case 270:
        [x, y, w, h] = [width, 0, height, width];
      default:
        [x, y, w, h] = [0, 0, width, height];
    }
    // end

    this.setAt(x, y, 0, 0);
    this.setDims(w, h);

    this.#createCanvas();

    if (this.width) {
      const [parentWidth, parentHeight] = this.parentDimensions;
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
    this.canvas.className = "squareEditorCanvas";
    this.canvas.setAttribute("data-l10n-id", "pdfjs-square-canvas");

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
    return this.rectangles.length === 0;
  }

  setDimensions(width, height) {
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);

    this.#realWidth = roundedWidth;
    this.#realHeight = roundedHeight;

    this.canvas.style.visibility = "hidden";

    const [parentWidth, parentHeight] = this.parentDimensions;
    this.width = width / parentWidth;
    this.height = height / parentHeight;
    this.fixAndSetPosition();

    if (this.#disableEditing) {
      const padding = this.#getPadding();
      const scaleFactorW = (width - padding) / this.#baseWidth;
      const scaleFactorH = (height - padding) / this.#baseHeight;
      // this.scaleFactor = Math.min(scaleFactorW, scaleFactorH); // scaleFactor is based on new width and height
      this.scaleFactorX = scaleFactorW;
      this.scaleFactorY = scaleFactorH;
    }
    // the new scaleFactor is passed to #updateTransform in #redraw

    this.#setCanvasDims(); // update canvas dims based on new dims of div
    this.#redraw(); // redraw based on new scaleFactor

    this.canvas.style.visibility = "visible";
    this.fixDims();
  }

  #setCanvasDims() {
    if (this.canvas) {
      this.canvas.width = this.div.clientWidth;
      this.canvas.height = this.div.clientHeight;
    }
  }

  #redraw() {
    if (this.isEmpty()) {
      this.#updateTransform();
      return;
    }
    // begin #setStroke()
    const { ctx, color, opacity, thickness } = this;
    const fixedLineWidth = thickness; // Set your desired fixed line width
    ctx.lineWidth = fixedLineWidth / Math.max(this.scaleFactorX, this.scaleFactorY);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.miterLimit = 10;
    ctx.strokeStyle = `${color}${opacityToHex(opacity)}`;
    // end
    const { canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.#updateTransform(); // update transform based on new scaleFactor

    // width and height of original shape's dims
    for (const rect of this.rectangles) {
      ctx.strokeRect(rect.startX, rect.startY, rect.width, rect.height);
    }
  }

  #updateTransform() {
    const padding = this.#getPadding() / 2;
    this.ctx.setTransform(
      this.scaleFactorX,
      0,
      0,
      this.scaleFactorY,
      this.translationX * this.scaleFactorX + padding,
      this.translationY * this.scaleFactorY + padding
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
    // begin this.#startDrawing(event.offsetX, event.offsetY);
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
      this.thickness ||= SquareEditor._defaultThickness;
      this.color ||=
        SquareEditor._defaultColor || AnnotationEditor._defaultLineColor;
      this.opacity ??= SquareEditor._defaultOpacity;
    }
    this.currentPath.push([event.offsetX, event.offsetY]);
    this.#hasSomethingToDraw = false;
    // begin this.#setStroke();
    const { ctx, color, opacity, thickness } = this;
    const fixedLineWidth = thickness; // Set your desired fixed line width
    ctx.lineWidth = fixedLineWidth / Math.max(this.scaleFactorX, this.scaleFactorY);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.miterLimit = 10;
    ctx.strokeStyle = `${color}${opacityToHex(opacity)}`;
    // end
    this.#requestFrameCallback = () => {
      if (this.#requestFrameCallback) {
        window.requestAnimationFrame(this.#requestFrameCallback);
      }
    };
    window.requestAnimationFrame(this.#requestFrameCallback);
    // end
  }

  get isResizable() {
    return !this.isEmpty() && this.#disableEditing;
  }

  remove() {
    if (this.canvas === null) {
      return;
    }

    if (!this.isEmpty()) {
      this.commit();
    }

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
    this.canvas.removeEventListener(
      "pointerleave",
      this.#boundCanvasPointerleave
    );
    this.canvas.removeEventListener(
      "pointermove",
      this.#boundCanvasPointermove
    );
    this.canvas.removeEventListener("pointerup", this.#boundCanvasPointerup);
    this.canvas.addEventListener("pointerdown", this.#boundCanvasPointerdown, {
      signal: this._uiManager._signal,
    });

    if (this.#canvasContextMenuTimeoutId) {
      clearTimeout(this.#canvasContextMenuTimeoutId);
    }
    this.#canvasContextMenuTimeoutId = setTimeout(() => {
      this.#canvasContextMenuTimeoutId = null;
      this.canvas.removeEventListener("contextmenu", noContextMenu);
    }, 10);

    this.#stopDrawing(event.offsetX, event.offsetY);

    this.addToAnnotationStorage();
    this.setInBackground();
  }

  #stopDrawing(x, y) {
    this.#requestFrameCallback = null;

    x = Math.min(Math.max(x, 0), this.canvas.width);
    y = Math.min(Math.max(y, 0), this.canvas.height);

    this.#draw(x, y);

    const currentPath = this.currentPath;
    if (currentPath.length > 0) {
      const [startX, startY] = currentPath[0];
      const width = x - startX;
      const height = y - startY;
      const rectX = Math.min(startX, x);
      const rectY = Math.min(startY, y);
      const rectWidth = Math.abs(width);
      const rectHeight = Math.abs(height);

      this.rectangles.push({
        startX: rectX,
        startY: rectY,
        width: rectWidth,
        height: rectHeight,
      });
    }

    this.currentPath = [];
  }

  #draw(x, y) {
    const currentPath = this.currentPath;

    if (currentPath.length > 0) {
      const [startX, startY] = currentPath[0];
      const width = x - startX;
      const height = y - startY;

      this.#currentPath2D = new Path2D();
      const path2D = this.#currentPath2D;

      const rectX = Math.min(startX, x);
      const rectY = Math.min(startY, y);
      const rectWidth = Math.abs(width);
      const rectHeight = Math.abs(height);

      path2D.rect(rectX, rectY, rectWidth, rectHeight);

      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      for (const rect of this.rectangles) {
        this.ctx.strokeRect(rect.startX, rect.startY, rect.width, rect.height);
      }
      this.ctx.stroke(path2D);
      currentPath[1] = [x, y];
    } else {
      currentPath.push([x, y]);
      this.#hasSomethingToDraw = false;
    }
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

    this.setInForeground();

    this.#disableEditing = true;
    this.div.classList.add("disabled");

    this.#fitToContent(/* firstTime = */ true);
    this.select();

    this.parent.addSquareEditorIfNeeded(/* isCommitting = */ true);

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

    for (const rect of this.rectangles) {
      const { startX, startY, width, height } = rect;
      xMin = Math.min(xMin, startX);
      yMin = Math.min(yMin, startY);
      xMax = Math.max(xMax, startX + width);
      yMax = Math.max(yMax, startY + height);
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
      annotationType: AnnotationEditorType.SQUARE,
      color,
      thickness: this.thickness,
      opacity: this.opacity,
      paths: this.#serializePaths(
        this.scaleFactor / this.parentScale,
        this.translationX,
        this.translationY,
        rect
      ),
      pageIndex: this.pageIndex,
      rect,
      rotation: this.rotation,
      structTreeParentId: this._structTreeParentId,
    };
  }

  #serializePaths(s, tx, ty, rect) {
    const rectangles = [];
    const shiftX = tx;
    const shiftY = ty;
    for (const rectangle of this.rectangles) {
      const { startX, startY, width, height } = rectangle;
      const points = [
        [startX + shiftX, startY + shiftY],
        [startX + width + shiftX, startY + shiftY],
        [startX + width + shiftX, startY + height + shiftY],
        [startX + shiftX, startY + height + shiftY],
      ];
      const pdfPoints = SquareEditor.#toPDFCoordinates(points, rect, this.rotation);
      rectangles.push({ rectangle: pdfPoints });
    }
    return rectangles;
  }

  static #toPDFCoordinates(points, rect, rotation) {
    const [blX, blY] = rect;
    const pdfPoints = points.map(([x, y]) => {
      switch (rotation) {
        case 90:
          return [blY + y, trX - x];
        case 180:
          return [trX - x, trY - y];
        case 270:
          return [trY - y, blX + x];
        default:
          return [blX + x, blY + y];
      }
    });
    return pdfPoints;
  }
  
  static deserialize(data, parent, uiManager) {
    if (data instanceof SquareAnnotationElement) {
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

    for (const { rectangle } of paths) {
      const editorPoints = SquareEditor.#fromPDFCoordinates(
        rectangle,
        rect,
        rotation
      );
      const [startX, startY] = editorPoints[0];
      editor.rectangles.push({ startX, startY, width, height });
    }

    const bbox = editor.#getBbox();
    editor.#baseWidth = Math.max(AnnotationEditor.MIN_SIZE, bbox[2] - bbox[0]);
    editor.#baseHeight = Math.max(AnnotationEditor.MIN_SIZE, bbox[3] - bbox[1]);
    // editor.#setScaleFactor(width, height);

    return editor;
  }

  static #fromPDFCoordinates(points, rect, rotation) {
    const [blX, blY, trX, trY] = rect;
    const editorPoints = points.map(([x, y]) => {
      switch (rotation) {
        case 90:
          return [trX - y, x - blY];
        case 180:
          return [trX - x, trY - y];
        case 270:
          return [y - blX, trY - x];
        default:
          return [x - blX, y - blY];
      }
    });
    return editorPoints;
  }

  static updateDefaultParams(type, value) {
    switch (type) {
      case AnnotationEditorParamsType.SQUARE_COLOR:
        SquareEditor._defaultColor = value;
        break;
    }
  }

  updateParams(type, value) {
    switch (type) {
      case AnnotationEditorParamsType.SQUARE_COLOR:
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
          type: AnnotationEditorParamsType.SQUARE_COLOR,
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


}

export { SquareEditor };
