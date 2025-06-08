/* Copyright 2022 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AnnotationEditorParamsType,
  AnnotationEditorType,
  shadow,
  Util,
} from "../../shared/util.js";
import { bindEvents, KeyboardManager } from "./tools.js";
import { FreeOutliner, Outliner } from "./outliner.js";
import { AnnotationEditor } from "./editor.js";
import { ColorPicker } from "./color_picker.js";
import { noContextMenu } from "../display_utils.js";

/**
 * Basic draw editor in order to generate an Highlight annotation.
 */
class HighlightEditor extends AnnotationEditor {
  #anchorNode = null;

  #anchorOffset = 0;

  #boxes;

  #clipPathId = null;

  #colorPicker = null;

  #focusOutlines = null;

  #focusNode = null;

  #focusOffset = 0;

  #highlightDiv = null;

  #highlightOutlines = null;

  #id = null;

  #isFreeHighlight = false;

  #isDeserialized = false;

  #boundKeydown = this.#keydown.bind(this);

  #lastPoint = null;

  #opacity;

  #outlineId = null;

  #text = "";

  #thickness;

  #methodOfCreation = "";

  static _defaultColor = null;

  static _defaultOpacity = 1;

  static _defaultThickness = 12;

  static _l10nPromise;

  static _type = "highlight";

  static _editorType = AnnotationEditorType.HIGHLIGHT;

  static _freeHighlightId = -1;

  static _freeHighlight = null;

  static _freeHighlightClipId = "";

  // Global registry to prevent duplicate editor instances
  static _editorRegistry = new Map();

  static get _keyboardManager() {
    const proto = HighlightEditor.prototype;
    return shadow(
      this,
      "_keyboardManager",
      new KeyboardManager([
        [["ArrowLeft", "mac+ArrowLeft"], proto._moveCaret, { args: [0] }],
        [["ArrowRight", "mac+ArrowRight"], proto._moveCaret, { args: [1] }],
        [["ArrowUp", "mac+ArrowUp"], proto._moveCaret, { args: [2] }],
        [["ArrowDown", "mac+ArrowDown"], proto._moveCaret, { args: [3] }],
      ])
    );
  }

  static createOrGet(params) {
    const annotationId = params.annotationElementId || params.id;
    
    // Check if an editor already exists for this annotation
    if (annotationId && HighlightEditor._editorRegistry.has(annotationId)) {
      const existing = HighlightEditor._editorRegistry.get(annotationId);
      if (existing && existing !== 'creating') {
        return existing;
      }
    }
    
    // Create new editor
    return new HighlightEditor(params);
  }

  constructor(params) {
    super({ ...params, name: "highlightEditor" });
    
    const annotationId = params.annotationElementId || params.id;
    
    this.color = params.color || HighlightEditor._defaultColor;
    this.#thickness = params.thickness || HighlightEditor._defaultThickness;
    this.#opacity = params.opacity || HighlightEditor._defaultOpacity;
    this.#boxes = params.boxes || null;
    this.#methodOfCreation = params.methodOfCreation || "";
    this.#text = params.text || "";
    this._isDraggable = false;

    // Store reference in registry
    if (annotationId) {
      HighlightEditor._editorRegistry.set(annotationId, this);
    }

    if (params.highlightId > -1) {
      this.#isFreeHighlight = true;
      this.#createFreeOutlines(params);
      this.#addToDrawLayer();
    } else if (params.anchorNode) {
      // This is a new highlight created from text selection
      this.#anchorNode = params.anchorNode;
      this.#anchorOffset = params.anchorOffset;
      this.#focusNode = params.focusNode;
      this.#focusOffset = params.focusOffset;
      this.#createOutlines();
      this.#addToDrawLayer();
      this.rotate(this.rotation);
    } else {
      // This is likely a deserialized highlight from saved PDF annotations
      // DO NOT create SVG elements here - they should already exist from initial page rendering
      // #createOutlines() will be called later in deserialize method, but NOT #addToDrawLayer()
      this.#isDeserialized = true;
    }
  }

  /** @inheritdoc */
  get telemetryInitialData() {
    return {
      action: "added",
      type: this.#isFreeHighlight ? "free_highlight" : "highlight",
      color: this._uiManager.highlightColorNames.get(this.color),
      thickness: this.#thickness,
      methodOfCreation: this.#methodOfCreation,
    };
  }

  /** @inheritdoc */
  get telemetryFinalData() {
    return {
      type: "highlight",
      color: this._uiManager.highlightColorNames.get(this.color),
    };
  }

  static computeTelemetryFinalData(data) {
    // We want to know how many colors have been used.
    return { numberOfColors: data.get("color").size };
  }

  #createOutlines() {
    const outliner = new Outliner(this.#boxes, /* borderWidth = */ 0.001);
    this.#highlightOutlines = outliner.getOutlines();
    ({
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
    } = this.#highlightOutlines.box);

    const outlinerForOutline = new Outliner(
      this.#boxes,
      /* borderWidth = */ 0.0025,
      /* innerMargin = */ 0.001,
      this._uiManager.direction === "ltr"
    );
    this.#focusOutlines = outlinerForOutline.getOutlines();

    // The last point is in the pages coordinate system.
    const { lastPoint } = this.#focusOutlines.box;
    this.#lastPoint = [
      (lastPoint[0] - this.x) / this.width,
      (lastPoint[1] - this.y) / this.height,
    ];
  }

  #createFreeOutlines({ highlightOutlines, highlightId, clipPathId }) {
    this.#highlightOutlines = highlightOutlines;
    const extraThickness = 1.5;
    this.#focusOutlines = highlightOutlines.getNewOutline(
      /* Slightly bigger than the highlight in order to have a little
         space between the highlight and the outline. */
      this.#thickness / 2 + extraThickness,
      /* innerMargin = */ 0.0025
    );

    if (highlightId >= 0) {
      this.#id = highlightId;
      this.#clipPathId = clipPathId;
      // We need to redraw the highlight because we change the coordinates to be
      // in the box coordinate system.
      this.parent.drawLayer.finalizeLine(highlightId, highlightOutlines);
      this.#outlineId = this.parent.drawLayer.highlightOutline(
        this.#focusOutlines
      );
    } else if (this.parent) {
      const angle = this.parent.viewport.rotation;
      this.parent.drawLayer.updateLine(this.#id, highlightOutlines);
      this.parent.drawLayer.updateBox(
        this.#id,
        HighlightEditor.#rotateBbox(
          this.#highlightOutlines.box,
          (angle - this.rotation + 360) % 360
        )
      );

      this.parent.drawLayer.updateLine(this.#outlineId, this.#focusOutlines);
      this.parent.drawLayer.updateBox(
        this.#outlineId,
        HighlightEditor.#rotateBbox(this.#focusOutlines.box, angle)
      );
    }
    const { x, y, width, height } = highlightOutlines.box;
    switch (this.rotation) {
      case 0:
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        break;
      case 90: {
        const [pageWidth, pageHeight] = this.parentDimensions;
        this.x = y;
        this.y = 1 - x;
        this.width = (width * pageHeight) / pageWidth;
        this.height = (height * pageWidth) / pageHeight;
        break;
      }
      case 180:
        this.x = 1 - x;
        this.y = 1 - y;
        this.width = width;
        this.height = height;
        break;
      case 270: {
        const [pageWidth, pageHeight] = this.parentDimensions;
        this.x = 1 - y;
        this.y = x;
        this.width = (width * pageHeight) / pageWidth;
        this.height = (height * pageWidth) / pageHeight;
        break;
      }
    }

    const { lastPoint } = this.#focusOutlines.box;
    this.#lastPoint = [(lastPoint[0] - x) / width, (lastPoint[1] - y) / height];
  }

  /** @inheritdoc */
  static initialize(l10n, uiManager) {
    AnnotationEditor.initialize(l10n, uiManager);
    HighlightEditor._defaultColor ||=
      uiManager.highlightColors?.values().next().value || "#fff066";
  }

  /** @inheritdoc */
  static updateDefaultParams(type, value) {
    switch (type) {
      case AnnotationEditorParamsType.HIGHLIGHT_DEFAULT_COLOR:
        HighlightEditor._defaultColor = value;
        break;
      case AnnotationEditorParamsType.HIGHLIGHT_THICKNESS:
        HighlightEditor._defaultThickness = value;
        break;
    }
  }

  /** @inheritdoc */
  translateInPage(x, y) {}

  /** @inheritdoc */
  get toolbarPosition() {
    return this.#lastPoint;
  }

  /** @inheritdoc */
  updateParams(type, value) {
    switch (type) {
      case AnnotationEditorParamsType.HIGHLIGHT_COLOR:
        this.#updateColor(value);
        break;
      case AnnotationEditorParamsType.HIGHLIGHT_THICKNESS:
        this.#updateThickness(value);
        break;
    }
  }

  static get defaultPropertiesToUpdate() {
    return [
      [
        AnnotationEditorParamsType.HIGHLIGHT_DEFAULT_COLOR,
        HighlightEditor._defaultColor,
      ],
      [
        AnnotationEditorParamsType.HIGHLIGHT_THICKNESS,
        HighlightEditor._defaultThickness,
      ],
    ];
  }

  /** @inheritdoc */
  get propertiesToUpdate() {
    return [
      [
        AnnotationEditorParamsType.HIGHLIGHT_COLOR,
        this.color || HighlightEditor._defaultColor,
      ],
      [
        AnnotationEditorParamsType.HIGHLIGHT_THICKNESS,
        this.#thickness || HighlightEditor._defaultThickness,
      ],
      [AnnotationEditorParamsType.HIGHLIGHT_FREE, this.#isFreeHighlight],
    ];
  }

  /**
   * Update the color and make this action undoable.
   * @param {string} color
   */
  #updateColor(color) {
    const setColor = col => {
      this.color = col;
      this.parent?.drawLayer.changeColor(this.#id, col);
      this.#colorPicker?.updateColor(col);
    };
    const savedColor = this.color;
    this.addCommands({
      cmd: setColor.bind(this, color),
      undo: setColor.bind(this, savedColor),
      post: this._uiManager.updateUI.bind(this._uiManager, this),
      mustExec: true,
      type: AnnotationEditorParamsType.HIGHLIGHT_COLOR,
      overwriteIfSameType: true,
      keepUndo: true,
    });

    this._reportTelemetry(
      {
        action: "color_changed",
        color: this._uiManager.highlightColorNames.get(color),
      },
      /* mustWait = */ true
    );
  }

  /**
   * Update the thickness and make this action undoable.
   * @param {number} thickness
   */
  #updateThickness(thickness) {
    const savedThickness = this.#thickness;
    const setThickness = th => {
      this.#thickness = th;
      this.#changeThickness(th);
    };
    this.addCommands({
      cmd: setThickness.bind(this, thickness),
      undo: setThickness.bind(this, savedThickness),
      post: this._uiManager.updateUI.bind(this._uiManager, this),
      mustExec: true,
      type: AnnotationEditorParamsType.INK_THICKNESS,
      overwriteIfSameType: true,
      keepUndo: true,
    });
    this._reportTelemetry(
      { action: "thickness_changed", thickness },
      /* mustWait = */ true
    );
  }

  /** @inheritdoc */
  async addEditToolbar() {
    const toolbar = await super.addEditToolbar();
    if (!toolbar) {
      return null;
    }
    if (this._uiManager.highlightColors) {
      this.#colorPicker = new ColorPicker({ editor: this });
      toolbar.addColorPicker(this.#colorPicker);
    }
    return toolbar;
  }

  /** @inheritdoc */
  disableEditing() {
    super.disableEditing();
    // SVG highlights remain visible - no need to restore anything
  }

  /** @inheritdoc */
  enableEditing() {
    super.enableEditing();
    this.div.classList.toggle("disabled", false);
  }

  /** @inheritdoc */
  fixAndSetPosition() {
    return super.fixAndSetPosition(this.#getRotation());
  }

  /** @inheritdoc */
  getBaseTranslation() {
    // The editor itself doesn't have any CSS border (we're drawing one
    // ourselves in using SVG).
    return [0, 0];
  }

  /** @inheritdoc */
  getRect(tx, ty) {
    return super.getRect(tx, ty, this.#getRotation());
  }

  /** @inheritdoc */
  onceAdded() {
    this.parent.addUndoableEditor(this);
    this.div.focus();
  }

  /** @inheritdoc */
  remove() {
    this.#cleanDrawLayer();
    
    // Remove the SVG highlight from canvas wrapper when the editor is deleted
    if (this.annotationElementId && this.parent) {
      const pageElement = this.parent.div.parentElement;
      if (pageElement) {
        const canvasWrapper = pageElement.querySelector('.canvasWrapper');
        if (canvasWrapper) {
          const existingSVG = canvasWrapper.querySelector(`svg.highlight[data-annotation-id="${this.annotationElementId}"]`);
          if (existingSVG) {
            existingSVG.remove();
          }
        }
      }
    }
    
    this._reportTelemetry({
      action: "deleted",
    });
    super.remove();
  }

  /** @inheritdoc */
  rebuild() {
    if (!this.parent) {
      return;
    }
    super.rebuild();
    if (this.div === null) {
      return;
    }

    this.#addToDrawLayer();

    if (!this.isAttachedToDOM) {
      // At some point this editor was removed and we're rebuilding it,
      // hence we must add it to its parent.
      this.parent.add(this);
    }
  }

  setParent(parent) {
    let mustBeSelected = false;
    if (this.parent && !parent) {
      // Don't clean draw layer for deserialized highlights to prevent duplication
      if (!this.#isDeserialized) {
        this.#cleanDrawLayer();
      }
    } else if (parent) {
      // Only add to draw layer if not already added (prevents duplication)
      if (this.#id === null) {
        this.#addToDrawLayer(parent);
      }
      // If mustBeSelected is true it means that this editor was selected
      // when its parent has been destroyed, hence we must select it again.
      mustBeSelected =
        !this.parent && this.div?.classList.contains("selectedEditor");
    }
    super.setParent(parent);
    this.show(this._isVisible);
    if (mustBeSelected) {
      // We select it after the parent has been set.
      this.select();
    }
  }

  #changeThickness(thickness) {
    if (!this.#isFreeHighlight) {
      return;
    }
    this.#createFreeOutlines({
      highlightOutlines: this.#highlightOutlines.getNewOutline(thickness / 2),
    });
    this.fixAndSetPosition();
    const [parentWidth, parentHeight] = this.parentDimensions;
    this.setDims(this.width * parentWidth, this.height * parentHeight);
  }

  #cleanDrawLayer() {
    if (this.#id === null || !this.parent) {
      return;
    }
    
    const annotationId = this.annotationElementId || this.id;
    
    // Clean up global tracking in both places
    if (annotationId) {
      // Only remove from registry if this is NOT a deserialized highlight
      if (!this.#isDeserialized) {
        HighlightEditor._editorRegistry.delete(annotationId);
      }
      
      // Also clean up pageView tracking if available
      if (this.parent && this.parent.pageView && this.parent.pageView._highlightEditors) {
        this.parent.pageView._highlightEditors.delete(annotationId);
      }
    }
    
    this.parent.drawLayer.remove(this.#id);
    this.#id = null;
    this.parent.drawLayer.remove(this.#outlineId);
    this.#outlineId = null;
  }

  #addToDrawLayer(parent = this.parent) {
    if (this.#id !== null) {
      return;
    }

    // Ensure draw layer is available before creating SVG elements
    if (!parent || !parent.drawLayer) {
      return;
    }
    
    const annotationId = this.annotationElementId || this.id;
    
    // Check if SVG elements already exist for this annotation
    if (annotationId && parent.drawLayer.div) {
      const existingSvgs = parent.drawLayer.div.querySelectorAll(`[data-annotation-id="${annotationId}"]`);
      if (existingSvgs.length >= 2) {
        
        // For deserialized highlights, try to reuse existing SVGs instead of creating new ones
        if (this.#isDeserialized) {
          // Try to extract the IDs from existing SVGs
          const highlightSvg = Array.from(existingSvgs).find(svg => svg.classList.contains('highlight'));
          const outlineSvg = Array.from(existingSvgs).find(svg => svg.classList.contains('highlightOutline'));
          
          if (highlightSvg && outlineSvg) {
            // Extract the IDs from the existing SVGs
            this.#id = highlightSvg.id || `highlight_${annotationId}`;
            this.#outlineId = outlineSvg.id || `outline_${annotationId}`;
            
            // Extract clipPath ID if available
            const clipPath = highlightSvg.querySelector('defs clipPath');
            if (clipPath) {
              this.#clipPathId = `url(#${clipPath.id})`;
            }
            
            return;
          }
        }
        
        // Remove existing SVGs before creating new ones to avoid duplicates
        existingSvgs.forEach(svg => svg.remove());
      }
    }

    // Clean up any existing elements (in case the check above missed something)
    if (this.#id !== null) {
      this.#cleanDrawLayer();
    }

    // Create new SVG elements
    ({ id: this.#id, clipPathId: this.#clipPathId } =
      parent.drawLayer.highlight(
        this.#highlightOutlines,
        this.color,
        this.#opacity
      ));
    this.#outlineId = parent.drawLayer.highlightOutline(this.#focusOutlines);
    
    // Mark the created SVG elements with annotation ID
    if (annotationId && parent.drawLayer.div && this.#id !== null && this.#outlineId !== null) {
      const allSvgs = parent.drawLayer.div.querySelectorAll('svg');
      
      for (const svg of allSvgs) {
        if (svg.classList.contains('highlight') && !svg.hasAttribute('data-annotation-id')) {
          svg.setAttribute('data-annotation-id', annotationId);
          break;
        }
      }
      
      for (const svg of allSvgs) {
        if (svg.classList.contains('highlightOutline') && !svg.hasAttribute('data-annotation-id')) {
          svg.setAttribute('data-annotation-id', annotationId);
          break;
        }
      }
    }
    
    if (this.#highlightDiv) {
      this.#highlightDiv.style.clipPath = this.#clipPathId;
    }
  }

  static #rotateBbox({ x, y, width, height }, angle) {
    switch (angle) {
      case 90:
        return {
          x: 1 - y - height,
          y: x,
          width: height,
          height: width,
        };
      case 180:
        return {
          x: 1 - x - width,
          y: 1 - y - height,
          width,
          height,
        };
      case 270:
        return {
          x: y,
          y: 1 - x - width,
          width: height,
          height: width,
        };
    }
    return {
      x,
      y,
      width,
      height,
    };
  }

  /** @inheritdoc */
  rotate(angle) {
    // We need to rotate the svgs because of the coordinates system.
    const { drawLayer } = this.parent;
    let box;
    if (this.#isFreeHighlight) {
      angle = (angle - this.rotation + 360) % 360;
      box = HighlightEditor.#rotateBbox(this.#highlightOutlines.box, angle);
    } else {
      // An highlight annotation is always drawn horizontally.
      box = HighlightEditor.#rotateBbox(this, angle);
    }
    drawLayer.rotate(this.#id, angle);
    drawLayer.rotate(this.#outlineId, angle);
    drawLayer.updateBox(this.#id, box);
    drawLayer.updateBox(
      this.#outlineId,
      HighlightEditor.#rotateBbox(this.#focusOutlines.box, angle)
    );
  }

  /** @inheritdoc */
  render() {
    if (this.div) {
      return this.div;
    }

    const div = super.render();
    if (this.#text) {
      div.setAttribute("aria-label", this.#text);
      div.setAttribute("role", "mark");
    }
    if (this.#isFreeHighlight) {
      div.classList.add("free");
    } else {
      this.div.addEventListener("keydown", this.#boundKeydown, {
        signal: this._uiManager._signal,
      });
    }
    const highlightDiv = (this.#highlightDiv = document.createElement("div"));
    div.append(highlightDiv);
    highlightDiv.setAttribute("aria-hidden", "true");
    highlightDiv.className = "internal";
    highlightDiv.style.clipPath = this.#clipPathId;
    const [parentWidth, parentHeight] = this.parentDimensions;
    this.setDims(this.width * parentWidth, this.height * parentHeight);

    bindEvents(this, this.#highlightDiv, ["pointerover", "pointerleave"]);
    this.enableEditing();

    return div;
  }

  pointerover() {
    this.parent.drawLayer.addClass(this.#outlineId, "hovered");
  }

  pointerleave() {
    this.parent.drawLayer.removeClass(this.#outlineId, "hovered");
  }

  #keydown(event) {
    HighlightEditor._keyboardManager.exec(this, event);
  }

  _moveCaret(direction) {
    this.parent.unselect(this);
    switch (direction) {
      case 0 /* left */:
      case 2 /* up */:
        this.#setCaret(/* start = */ true);
        break;
      case 1 /* right */:
      case 3 /* down */:
        this.#setCaret(/* start = */ false);
        break;
    }
  }

  #setCaret(start) {
    if (!this.#anchorNode) {
      return;
    }
    const selection = window.getSelection();
    if (start) {
      selection.setPosition(this.#anchorNode, this.#anchorOffset);
    } else {
      selection.setPosition(this.#focusNode, this.#focusOffset);
    }
  }

  /** @inheritdoc */
  select() {
    super.select();
    if (!this.#outlineId) {
      return;
    }
    this.parent?.drawLayer.removeClass(this.#outlineId, "hovered");
    this.parent?.drawLayer.addClass(this.#outlineId, "selected");
  }

  /** @inheritdoc */
  unselect() {
    super.unselect();
    if (!this.#outlineId) {
      return;
    }
    this.parent?.drawLayer.removeClass(this.#outlineId, "selected");
    if (!this.#isFreeHighlight) {
      this.#setCaret(/* start = */ false);
    }
  }

  /** @inheritdoc */
  get _mustFixPosition() {
    return !this.#isFreeHighlight;
  }

  /** @inheritdoc */
  show(visible = this._isVisible) {
    // Only call super.show if div has been created
    if (this.div) {
      super.show(visible);
    }
    if (this.parent) {
      // For persistent/deserialized highlights, always keep the SVG visible
      // Only hide SVG elements for non-persistent highlights
      const keepSvgVisible = this.#isDeserialized || visible;
      this.parent.drawLayer.show(this.#id, keepSvgVisible);
      this.parent.drawLayer.show(this.#outlineId, keepSvgVisible);
    }
  }

  #getRotation() {
    // Highlight annotations are always drawn horizontally but if
    // a free highlight annotation can be rotated.
    return this.#isFreeHighlight ? this.rotation : 0;
  }

  #serializeBoxes() {
    if (this.#isFreeHighlight) {
      return null;
    }
    const boxes = this.#boxes;
    if (!boxes || boxes.length === 0) {
      return null;
    }
    const [pageWidth, pageHeight] = this.pageDimensions;
    const [pageX, pageY] = this.pageTranslation;
    const quadPoints = new Float32Array(boxes.length * 8);
    let i = 0;
    for (const { x, y, width, height } of boxes) {
      const sx = x * pageWidth + pageX;
      const sy = (1 - y - height) * pageHeight + pageY;
      // The specifications say that the rectangle should start from the bottom
      // left corner and go counter-clockwise.
      // But when opening the file in Adobe Acrobat it appears that this isn't
      // correct hence the 4th and 6th numbers are just swapped.
      quadPoints[i] = quadPoints[i + 4] = sx;
      quadPoints[i + 1] = quadPoints[i + 3] = sy;
      quadPoints[i + 2] = quadPoints[i + 6] = sx + width * pageWidth;
      quadPoints[i + 5] = quadPoints[i + 7] = sy + height * pageHeight;
      i += 8;
    }
    return quadPoints;
  }

  #serializeOutlines(rect) {
    return this.#highlightOutlines.serialize(rect, this.#getRotation());
  }

  static startHighlighting(parent, isLTR, { target: textLayer, x, y }) {
    const {
      x: layerX,
      y: layerY,
      width: parentWidth,
      height: parentHeight,
    } = textLayer.getBoundingClientRect();
    const pointerMove = e => {
      this.#highlightMove(parent, e);
    };
    const signal = parent._signal;
    const pointerDownOptions = { capture: true, passive: false, signal };
    const pointerDown = e => {
      // Avoid to have undesired clicks during the drawing.
      e.preventDefault();
      e.stopPropagation();
    };
    const pointerUpCallback = e => {
      textLayer.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("blur", pointerUpCallback);
      window.removeEventListener("pointerup", pointerUpCallback);
      window.removeEventListener(
        "pointerdown",
        pointerDown,
        pointerDownOptions
      );
      window.removeEventListener("contextmenu", noContextMenu);
      this.#endHighlight(parent, e);
    };
    window.addEventListener("blur", pointerUpCallback, { signal });
    window.addEventListener("pointerup", pointerUpCallback, { signal });
    window.addEventListener("pointerdown", pointerDown, pointerDownOptions);
    window.addEventListener("contextmenu", noContextMenu, { signal });

    textLayer.addEventListener("pointermove", pointerMove, { signal });
    this._freeHighlight = new FreeOutliner(
      { x, y },
      [layerX, layerY, parentWidth, parentHeight],
      parent.scale,
      this._defaultThickness / 2,
      isLTR,
      /* innerMargin = */ 0.001
    );
    ({ id: this._freeHighlightId, clipPathId: this._freeHighlightClipId } =
      parent.drawLayer.highlight(
        this._freeHighlight,
        this._defaultColor,
        this._defaultOpacity,
        /* isPathUpdatable = */ true
      ));
  }

  static #highlightMove(parent, event) {
    if (this._freeHighlight.add(event)) {
      // Redraw only if the point has been added.
      parent.drawLayer.updatePath(this._freeHighlightId, this._freeHighlight);
    }
  }

  static #endHighlight(parent, event) {
    if (!this._freeHighlight.isEmpty()) {
      parent.createAndAddNewEditor(event, false, {
        highlightId: this._freeHighlightId,
        highlightOutlines: this._freeHighlight.getOutlines(),
        clipPathId: this._freeHighlightClipId,
        methodOfCreation: "main_toolbar",
      });
    } else {
      parent.drawLayer.removeFreeHighlight(this._freeHighlightId);
    }
    this._freeHighlightId = -1;
    this._freeHighlight = null;
    this._freeHighlightClipId = "";
  }

  /** @inheritdoc */
  static deserialize(data, parent, uiManager) {
    // Handle different data structures:
    // 1. When called from annotation layer: data has id/annotationElementId
    // 2. When called from editor layer during edit mode: data is annotation element with data.id
    let annotationId = data.id || data.annotationElementId;
    
    // If it's an annotation element being passed, extract the ID from its data
    if (!annotationId && data.data && data.data.id) {
      annotationId = data.data.id;
    }
    
    // If annotationId is still null, try the annotationType property path
    if (!annotationId && data.annotationType) {
      // This might be serialized editor data - check for other ID properties
      annotationId = data._annotationElementId || data.annotationElementId;
    }
    
    if (annotationId && HighlightEditor._editorRegistry.has(annotationId)) {
      const existing = HighlightEditor._editorRegistry.get(annotationId);
      
      if (existing && existing !== 'creating') {
        // Check if the existing editor is properly initialized
        if (!existing.div || !existing.isAttachedToDOM) {
          // Remove the broken editor from registry and let a new one be created
          HighlightEditor._editorRegistry.delete(annotationId);
          
          // Continue with creating a new editor below
        } else {
          // Editor is properly initialized, return it
          return existing;
        }
      }
    }
    
    // Additional check: if SVG elements already exist, don't create a new editor
    const drawLayerExists = parent?.drawLayer?.div;
    const existingSvgs = drawLayerExists ? parent.drawLayer.div.querySelectorAll(`[data-annotation-id="${annotationId}"]`) : [];
    
    if (drawLayerExists && existingSvgs.length >= 2) {
      // SVGs exist but no valid editor - we'll create a new editor that can manage them
      // The #addToDrawLayer method will handle cleanup of existing SVGs
    }
    
    // Mark if SVGs already exist for this annotation (for the initialization method)
    const svgsAlreadyExist = annotationId && parent?.drawLayer?.div?.querySelectorAll(`[data-annotation-id="${annotationId}"]`).length >= 2;
    
    // Normalize the data structure for the parent deserialize method
    let normalizedData = data;
    if (data.data && !data.rect && !data.color && !data.quadPoints) {
      // This is an annotation element - extract the needed properties
      normalizedData = {
        ...data.data, // Include the original annotation data
        rect: data.rect || data.data.rect,
        color: data.color || data.data.color,
        quadPoints: data.quadPoints || data.data.quadPoints,
        opacity: data.opacity || data.data.opacity,
        rotation: data.rotation || data.data.rotation,
        annotationType: 14, // AnnotationEditorType.HIGHLIGHT
        annotationEditorType: 14,
        id: annotationId
      };
    }
    
    const editor = super.deserialize(normalizedData, parent, uiManager);

    // Handle different data structures for rect, color, and quadPoints
    let rect, color, quadPoints;
    
    if (normalizedData.rect && normalizedData.color && normalizedData.quadPoints) {
      rect = normalizedData.rect;
      color = normalizedData.color;
      quadPoints = normalizedData.quadPoints;
    } else {
      // Fallback
      rect = [0, 0, 1, 1];
      color = [255, 255, 153];
      quadPoints = [];
    }

    const [blX, blY, trX, trY] = rect;
    
    editor.color = Util.makeHexColor(...color);
    
    // Set the annotation element ID for proper tracking
    editor.annotationElementId = annotationId;
    
    // Register with the correct annotation ID in the registry
    if (annotationId) {
      HighlightEditor._editorRegistry.set(annotationId, editor);
    }
    
    // Initialize the editor with the deserialized data
    editor.initializeFromDeserialization(normalizedData, blX, blY, trX, trY, quadPoints, svgsAlreadyExist);
    
    return editor;
  }
  
  initializeFromDeserialization(data, blX, blY, trX, trY, quadPoints, hasSvgs = false) {
    this.#opacity = data.opacity || HighlightEditor._defaultOpacity;
    
    // Store pageView reference for global tracking
    if (data.pageView && this.parent) {
      this.parent.pageView = data.pageView;
    }
    
    // Get page dimensions to convert PDF coordinates to 0-1 normalized coordinates
    const [pageWidth, pageHeight] = this.pageDimensions;
    
    // Apply the same coordinate transformation as getRectInCurrentCoords
    // Transform quadPoints to match the coordinate system used by the editor
    const boxes = [];
    for (let i = 0; i < quadPoints.length; i += 8) {
      // QuadPoints format: [x1, y1, x2, y2, x3, y3, x4, y4]
      // Apply the same Y-coordinate flip as getRectInCurrentCoords (rotation 0 case)
      const x1 = quadPoints[i] / pageWidth;
      const y1 = (pageHeight - quadPoints[i + 1]) / pageHeight;
      const x2 = quadPoints[i + 2] / pageWidth;
      const y2 = (pageHeight - quadPoints[i + 3]) / pageHeight;
      const x3 = quadPoints[i + 4] / pageWidth;
      const y3 = (pageHeight - quadPoints[i + 5]) / pageHeight;
      const x4 = quadPoints[i + 6] / pageWidth;
      const y4 = (pageHeight - quadPoints[i + 7]) / pageHeight;
      
      // Calculate the bounding box of this quad
      const minX = Math.min(x1, x2, x3, x4);
      const maxX = Math.max(x1, x2, x3, x4);
      const minY = Math.min(y1, y2, y3, y4);
      const maxY = Math.max(y1, y2, y3, y4);
      
      boxes.push({
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      });
    }
    this.#boxes = boxes;
    
    // Create outlines for the editor
    this.#createOutlines();
    
    // Set the annotation element ID for duplicate prevention
    this.annotationElementId = data.data?.id || data.id;
    
    // Only create SVG elements if they don't already exist
    // This prevents duplicate creation when edit mode is enabled
    if (!hasSvgs) {
      const annotationId = this.annotationElementId;
      const existingSvgs = this.parent?.drawLayer?.div?.querySelectorAll(`[data-annotation-id="${annotationId}"]`);
      
      if (!existingSvgs || existingSvgs.length === 0) {
        // No existing SVGs found, this is likely the initial creation
        this.#addToDrawLayer();
      }
      // If existingSvgs.length > 0, SVGs already exist - don't create new ones
    }
    // If hasSvgs is true, definitely don't create new SVGs
  }

  /** @inheritdoc */
  serialize(isForCopying = false) {
    // It doesn't make sense to copy/paste a highlight annotation.
    if (this.isEmpty() || isForCopying) {
      return null;
    }

    const rect = this.getRect(0, 0);
    const color = AnnotationEditor._colorManager.convert(this.color);

    return {
      annotationType: AnnotationEditorType.HIGHLIGHT,
      color,
      opacity: this.#opacity,
      thickness: this.#thickness,
      quadPoints: this.#serializeBoxes(),
      outlines: this.#serializeOutlines(rect),
      pageIndex: this.pageIndex,
      rect,
      rotation: this.#getRotation(),
      structTreeParentId: this._structTreeParentId,
    };
  }

  static canCreateNewEmptyEditor() {
    return false;
  }
}

export { HighlightEditor };
