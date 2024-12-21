Each editor has its own file such as ink.js, square.js, etc.

the methods named: `#serializePaths, static deserialize,  serialize()` are used in copy/paste and undo/redo operations.

  #setStroke() {
is responsible for line width in redraw

we need to fix the parentscale the same way we did with scalefactor



- I need to find this.scratchCanvas source which is stores the bad rectangle


- wrong shape:
 1- rectangle defined wrong
 2- topdfcoordinates wrong
 3- what's drawing the rectangle before printing

-> I couldn't find the rendering point where exactly the pdf is rendered to a canva but just found
scratchCanvas in useRenderedPage is the one which produces the wrong rectangle (arc).
-> I found render() function is responsible with renderContext; pop... function. It's like rendering is not something we could inspect or modify.
-> save also reported new issue; "this.createNewAppearanceStream is not a function". its source is in,
annotations.js. I couldn't find it using the debugger but manually guessing to search this function and found it in annotation.js and commenting out relevant portions revealed the reported error.
- we need to understand annotation.js

-> some source files are not loaded in chrome sources tab for some reason such as annotations.js

and maybe the source problem for not saving/printing properly is due to missing parts in annotation.js

<div style="border: 1px solid; padding: 10px; width: fit-content;">
  <b> Conclusion: </b>

  <p> 1- The source of the problem (not saving/printing properly) is in the <code>annotations.js</code> file. </p>

  <p>For all future annotations; in addition to the known files; such as adding an editor file within <code>src/display/editor</code>, the editor must be added properly to <code>src/display/annotation.js</code> as well to ensure proper rendering and saving/printing.</p>
</div>


__TODO:__
- [ ] clean: annotations.js, all editors
- [ ] Refine square and line editors; define square and line properly (not mimicking ink) and remove unncecessary loops
- [ ] Pay attention to and improve `createNewAppearanceStream` in `annotation.js`; for instance,
```
`${numberToString(bezier[0])} ${numberToString(bezier[1])} m`
```
`m` has a meaning `moveTo` in canva context.



##### To install for firefox:


unzip /home/hamad12a_pop/firefox/omni.ja -d test
cd test
rm -rf ./chrome/pdfjs/content/build/*
rm -rf ./chrome/pdfjs/content/web/*
npx gulp mozcentral
cp -r /media/hamad12a_pop/be7694cc-8588-4281-b142-cfa422e8702e/home/hamad12a/Repo/pdf.js/build/mozcentral/browser/extensions/pdfjs/content/web/* ./chrome/pdfjs/content/web/
cp -r /media/hamad12a_pop/be7694cc-8588-4281-b142-cfa422e8702e/home/hamad12a/Repo/pdf.js/build/mozcentral/browser/extensions/pdfjs/content/build/* ./chrome/pdfjs/content/build/
zip -qr9XD omni.ja *
cp omni.ja ../

restart firefox