/* Copyright 2023 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.          const existingAnnotationId = existingSvg.getAttribute('data-annotation-id');
          if (!existingAnnotationId) {
            existingSvg.setAttribute('data-annotation-id', annotationId);
          }
          return existingId;
        } may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { DOMSVGFactory } from "./display_utils.js";
import { shadow } from "../shared/util.js";

/**
 * Manage the SVGs drawn on top of the page canvas.
 * It's important to have them directly on top of the canvas because we want to
 * be able to use mix-blend-mode for some of them.
 */
class DrawLayer {
  #parent = null;

  #id = 0;

  #mapping = new Map();

  #toUpdate = new Map();

  constructor({ pageIndex }) {
    this.pageIndex = pageIndex;
  }

  setParent(parent) {
    if (!this.#parent) {
      this.#parent = parent;
      return;
    }

    if (this.#parent !== parent) {
      if (this.#mapping.size > 0) {
        for (const root of this.#mapping.values()) {
          root.remove();
          parent.append(root);
        }
      }
      this.#parent = parent;
    }
  }
  
  /**
   * Get the annotation editor UI manager from various possible parent contexts
   * @private
   */
  #getUIManager() {
    // Try multiple paths to find the UI manager
    return this.#parent?.annotationEditorUIManager || 
           this.#parent?._layerProperties?.annotationEditorUIManager ||
           this.#parent?.pageView?._layerProperties?.annotationEditorUIManager ||
           null;
  }

  static get _svgFactory() {
    return shadow(this, "_svgFactory", new DOMSVGFactory());
  }

  static #setBox(element, { x = 0, y = 0, width = 1, height = 1 } = {}) {
    const { style } = element;
    style.top = `${100 * y}%`;
    style.left = `${100 * x}%`;
    style.width = `${100 * width}%`;
    style.height = `${100 * height}%`;
  }

  #createSVG(box) {
    const svg = DrawLayer._svgFactory.create(1, 1, /* skipDimensions = */ true);
    this.#parent.append(svg);
    svg.setAttribute("aria-hidden", true);
    DrawLayer.#setBox(svg, box);

    return svg;
  }

  #createClipPath(defs, pathId) {
    const clipPath = DrawLayer._svgFactory.createElement("clipPath");
    defs.append(clipPath);
    const clipPathId = `clip_${pathId}`;
    clipPath.setAttribute("id", clipPathId);
    clipPath.setAttribute("clipPathUnits", "objectBoundingBox");
    const clipPathUse = DrawLayer._svgFactory.createElement("use");
    clipPath.append(clipPathUse);
    clipPathUse.setAttribute("href", `#${pathId}`);
    clipPathUse.classList.add("clip");

    return clipPathId;
  }

  highlight(outlines, color, opacity, isPathUpdatable = false, annotationId = null) {
    // Check if annotation is deleted before creating SVG
    const uiManager = this.#getUIManager();
    if (annotationId && uiManager?.isDeletedAnnotationElement?.(annotationId)) {
      return null;
    }
    
    // Check for existing highlight with same content
    if (annotationId) {
      const existingId = this.findExistingHighlight(outlines, color, opacity);
      if (existingId !== null) {
        const existingSvg = this.#mapping.get(existingId);
        if (existingSvg) {
          // Update the existing SVG with the new annotation ID if needed
          const existingAnnotationId = existingSvg.getAttribute('data-annotation-id');
          if (!existingAnnotationId) {
            existingSvg.setAttribute('data-annotation-id', annotationId);
          }
          return { id: existingId, clipPathId: existingSvg.getAttribute('clip-path') || `url(#clippath_${existingId})` };
        }
      }
    }

    const id = this.#id++;
    const root = this.#createSVG(outlines.box);
    root.classList.add("highlight");
    if (outlines.free) {
      root.classList.add("free");
    }
    const defs = DrawLayer._svgFactory.createElement("defs");
    root.append(defs);
    const path = DrawLayer._svgFactory.createElement("path");
    defs.append(path);
    const pathId = `path_p${this.pageIndex}_${id}`;
    path.setAttribute("id", pathId);
    path.setAttribute("d", outlines.toSVGPath());

    if (isPathUpdatable) {
      this.#toUpdate.set(id, path);
    }

    // Create the clipping path for the editor div.
    const clipPathId = this.#createClipPath(defs, pathId);

    const use = DrawLayer._svgFactory.createElement("use");
    root.append(use);
    root.setAttribute("fill", color);
    root.setAttribute("fill-opacity", opacity);
    use.setAttribute("href", `#${pathId}`);

    // Set annotation ID if provided
    if (annotationId) {
      root.setAttribute('data-annotation-id', annotationId);
    }

    this.#mapping.set(id, root);

    return { id, clipPathId: `url(#${clipPathId})` };
  }

  highlightOutline(outlines, annotationId = null) {
    // Check if annotation is deleted before creating SVG
    const uiManager = this.#getUIManager();
    if (annotationId && uiManager?.isDeletedAnnotationElement?.(annotationId)) {
      return null;
    }
    
    // Check for existing highlight outline with same content
    if (annotationId) {
      const existingId = this.findExistingHighlightOutline(outlines);
      if (existingId !== null) {
        const existingSvg = this.#mapping.get(existingId);
        if (existingSvg) {
          // Update the existing SVG with the new annotation ID if needed
          const existingAnnotationId = existingSvg.getAttribute('data-annotation-id');
          if (!existingAnnotationId) {
            existingSvg.setAttribute('data-annotation-id', annotationId);
          }
          console.warn(`Reusing existing highlight outline SVG for annotation ${annotationId}, existing ID: ${existingId}`);
          return existingId;
        }
      }
    }

    // We cannot draw the outline directly in the SVG for highlights because
    // it composes with its parent with mix-blend-mode: multiply.
    // But the outline has a different mix-blend-mode, so we need to draw it in
    // its own SVG.
    const id = this.#id++;
    const root = this.#createSVG(outlines.box);
    root.classList.add("highlightOutline");
    
    // Set annotation ID if provided
    if (annotationId) {
      root.setAttribute('data-annotation-id', annotationId);
    }

    const defs = DrawLayer._svgFactory.createElement("defs");
    root.append(defs);
    const path = DrawLayer._svgFactory.createElement("path");
    defs.append(path);
    const pathId = `path_p${this.pageIndex}_${id}`;
    path.setAttribute("id", pathId);
    path.setAttribute("d", outlines.toSVGPath());
    path.setAttribute("vector-effect", "non-scaling-stroke");

    let maskId;
    if (outlines.free) {
      root.classList.add("free");
      const mask = DrawLayer._svgFactory.createElement("mask");
      defs.append(mask);
      maskId = `mask_p${this.pageIndex}_${id}`;
      mask.setAttribute("id", maskId);
      mask.setAttribute("maskUnits", "objectBoundingBox");
      const rect = DrawLayer._svgFactory.createElement("rect");
      mask.append(rect);
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      rect.setAttribute("fill", "white");
      const use = DrawLayer._svgFactory.createElement("use");
      mask.append(use);
      use.setAttribute("href", `#${pathId}`);
      use.setAttribute("stroke", "none");
      use.setAttribute("fill", "black");
      use.setAttribute("fill-rule", "nonzero");
      use.classList.add("mask");
    }

    const use1 = DrawLayer._svgFactory.createElement("use");
    root.append(use1);
    use1.setAttribute("href", `#${pathId}`);
    if (maskId) {
      use1.setAttribute("mask", `url(#${maskId})`);
    }
    const use2 = use1.cloneNode();
    root.append(use2);
    use1.classList.add("mainOutline");
    use2.classList.add("secondaryOutline");

    this.#mapping.set(id, root);

    return id;
  }

  finalizeLine(id, line) {
    const path = this.#toUpdate.get(id);
    this.#toUpdate.delete(id);
    this.updateBox(id, line.box);
    path.setAttribute("d", line.toSVGPath());
  }

  updateLine(id, line) {
    const root = this.#mapping.get(id);
    const defs = root.firstChild;
    const path = defs.firstChild;
    path.setAttribute("d", line.toSVGPath());
  }

  removeFreeHighlight(id) {
    this.remove(id);
    this.#toUpdate.delete(id);
  }

  updatePath(id, line) {
    this.#toUpdate.get(id).setAttribute("d", line.toSVGPath());
  }

  updateBox(id, box) {
    const element = this.#mapping.get(id);
    if (element) {
      DrawLayer.#setBox(element, box);
    }
  }

  show(id, visible) {
    const element = this.#mapping.get(id);
    if (element && element.classList) {
      element.classList.toggle("hidden", !visible);
    }
  }

  rotate(id, angle) {
    const element = this.#mapping.get(id);
    if (element) {
      element.setAttribute("data-main-rotation", angle);
    }
  }

  changeColor(id, color) {
    const element = this.#mapping.get(id);
    if (element) {
      element.setAttribute("fill", color);
    }
  }

  changeOpacity(id, opacity) {
    const element = this.#mapping.get(id);
    if (element) {
      element.setAttribute("fill-opacity", opacity);
    }
  }

  addClass(id, className) {
    const element = this.#mapping.get(id);
    if (element && element.classList) {
      element.classList.add(className);
    }
  }

  removeClass(id, className) {
    const element = this.#mapping.get(id);
    if (element && element.classList) {
      element.classList.remove(className);
    }
  }

  remove(id) {
    if (this.#parent === null) {
      return;
    }
    const element = this.#mapping.get(id);
    if (element) {
      element.remove();
      this.#mapping.delete(id);
    }
  }

  destroy() {
    this.#parent = null;
    for (const root of this.#mapping.values()) {
      root.remove();
    }
    this.#mapping.clear();
  }

  // Method to set annotation ID on an existing SVG element
  setAnnotationId(id, annotationId) {
    const root = this.#mapping.get(id);
    if (root && annotationId) {
      root.setAttribute('data-annotation-id', annotationId);
    }
  }

  // Method to find SVG ID by annotation ID and type
  findByAnnotationId(annotationId, svgType) {
    if (!annotationId) {
      return null;
    }
    
    for (const [id, svgElement] of this.#mapping) {
      if (svgType && !svgElement.classList.contains(svgType)) {
        continue;
      }
      
      const dataAnnotationId = svgElement.getAttribute('data-annotation-id');
      if (dataAnnotationId === annotationId) {
        return id;
      }
    }
    
    return null;
  }

  // Method to get SVG element by ID
  getSvgElement(id) {
    return this.#mapping.get(id);
  }

  // Method to find existing highlight with same content
  findExistingHighlight(outlines, color, opacity) {
    const targetPath = outlines.toSVGPath();
    const targetColor = color;
    const targetOpacity = opacity;
    
    for (const [id, svgElement] of this.#mapping) {
      if (!svgElement.classList.contains('highlight')) {
        continue;
      }
      
      const fill = svgElement.getAttribute('fill');
      const fillOpacity = svgElement.getAttribute('fill-opacity');
      
      if (fill === targetColor && fillOpacity === targetOpacity) {
        // Check if the path matches
        const pathElement = svgElement.querySelector('path');
        if (pathElement && pathElement.getAttribute('d') === targetPath) {
          return id;
        }
      }
    }
    
    return null;
  }

  // Method to find existing highlight outline with same content
  findExistingHighlightOutline(outlines) {
    const targetPath = outlines.toSVGPath();
    
    for (const [id, svgElement] of this.#mapping) {
      if (!svgElement.classList.contains('highlightOutline')) {
        continue;
      }
      
      // Check if the path matches
      const pathElement = svgElement.querySelector('path');
      if (pathElement && pathElement.getAttribute('d') === targetPath) {
        return id;
      }
    }
    
    return null;
  }
}

export { DrawLayer };
