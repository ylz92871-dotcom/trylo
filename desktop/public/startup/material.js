/* Approved v9 compositor, reused without changing its shader or contour. */
(function () {
'use strict';
// The exact contour is prepared once by scripts/prepare-startup-contour.mjs,
// rather than flood filling and distance-transforming 1.57M pixels at startup.
function createMaterial(material, image, contourImage) {
  const gl = material.getContext('webgl',{alpha:true,premultipliedAlpha:false,antialias:false,preserveDrawingBuffer:true,powerPreference:'low-power'});
  if(!gl) throw new Error('WebGL unavailable');
  const vertex = `attribute vec2 a_position; varying vec2 v_uv;
    void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}`;
  const fragment = `precision highp float;
    uniform sampler2D u_image;
    uniform sampler2D u_contour;
    uniform float u_scan;
    uniform float u_light;
    varying vec2 v_uv;
    float gauss(float x,float radius){return exp(-.5*x*x/(radius*radius));}
    void main(){
      vec2 p=vec2(v_uv.x,1.-v_uv.y);
      float alpha=texture2D(u_contour,v_uv).r;
      if(alpha<.002)discard;
      vec3 base=texture2D(u_image,v_uv).rgb;
      float lum=dot(base,vec3(.2126,.7152,.0722));
      float d=dot(p,vec2(.75,.65))-u_scan;
      float band=gauss(d,.054)*.34+gauss(d,.014)*.19;
      float response=mix(.54,1.,smoothstep(.13,.67,lum));
      float spec=band*response*u_light;
      // The three tiny inner-elbow glints sit on the approved facet joins.
      // They are lit only as the same diagonal light reaches that position.
      vec2 c1=vec2(.456,.385),c2=vec2(.369,.697),c3=vec2(.627,.599);
      float g1=gauss(length((p-c1)*vec2(1.,1.8)),.015)*gauss(dot(c1,vec2(.75,.65))-u_scan,.035);
      float g2=gauss(length((p-c2)*vec2(1.4,1.)),.014)*gauss(dot(c2,vec2(.75,.65))-u_scan,.035);
      float g3=gauss(length((p-c3)*vec2(1.5,1.)),.013)*gauss(dot(c3,vec2(.75,.65))-u_scan,.035);
      float glint=(g1+g2+g3)*.78*u_light;
      vec3 color=base+(vec3(1.,.985,.945)-base)*min(.83,spec+glint);
      gl_FragColor=vec4(color,alpha);
    }`;
  function shader(type,source){
    const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const vs=shader(gl.VERTEX_SHADER,vertex),fs=shader(gl.FRAGMENT_SHADER,fragment);
  const program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const attribute=gl.getAttribLocation(program,'a_position');
  gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
  const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.uniform1i(gl.getUniformLocation(program,'u_image'),0);
  const contour=gl.createTexture();gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,contour);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,contourImage);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.uniform1i(gl.getUniformLocation(program,'u_contour'),1);
  const scanLocation=gl.getUniformLocation(program,'u_scan');
  const lightLocation=gl.getUniformLocation(program,'u_light');
  gl.clearColor(0,0,0,0);
  let lastScan,lastLight,lastWidth,lastHeight;
  return {
    draw(scan,light){
      // During the turn/landing only the compositor transform changes.
      if(scan===lastScan&&light===lastLight&&material.width===lastWidth&&material.height===lastHeight)return false;
      gl.viewport(0,0,material.width,material.height);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform1f(scanLocation,scan);gl.uniform1f(lightLocation,light);gl.drawArrays(gl.TRIANGLES,0,6);
      lastScan=scan;lastLight=light;lastWidth=material.width;lastHeight=material.height;return true;
    },
    dispose(){gl.deleteTexture(texture);gl.deleteTexture(contour);gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);}
  };
}

// In a worker this is the GPU implementation. In the document, create the
// context and compile shaders off the animation/application thread.
if(typeof window==='undefined') { globalThis.TryloStartupMaterial=createMaterial; return; }
window.TryloStartupMaterial=function(canvas,image,contour,onReady=()=>{},onError=()=>{}) {
  if(typeof Worker!=='function'||typeof canvas.transferControlToOffscreen!=='function'||typeof createImageBitmap!=='function') {
    const material=createMaterial(canvas,image,contour);onReady();return material;
  }
  const worker=new Worker('/startup/material-worker.js');
  let surface;
  try { surface=canvas.transferControlToOffscreen(); }
  catch(error) { worker.terminate();throw error; }
  let disposed=false,ready=false,lastFrame=null,width=canvas.width,height=canvas.height;
  let sentScan,sentLight,sentWidth,sentHeight;
  function dispose(){if(disposed)return;disposed=true;worker.terminate();}
  function fail(){if(disposed)return;dispose();onError();}
  function send(){
    if(!ready||disposed||!lastFrame)return false;
    const [scan,light]=lastFrame;
    if(scan===sentScan&&light===sentLight&&width===sentWidth&&height===sentHeight)return false;
    worker.postMessage({type:'draw',scan,light,width,height});
    sentScan=scan;sentLight=light;sentWidth=width;sentHeight=height;return true;
  }
  worker.onmessage=event=>{
    if(disposed)return;
    if(event.data.type==='ready'){ready=true;send();onReady();}
    else if(event.data.type==='failed')fail();
  };
  worker.onerror=event=>{event.preventDefault();fail();};
  // ImageBitmap uploads ignore WebGL's UNPACK_FLIP_Y_WEBGL; flip both sources
  // during their asynchronous copy to preserve the approved texture mapping.
  Promise.allSettled([image,contour].map(source=>Promise.resolve().then(()=>
    createImageBitmap(source,{imageOrientation:'flipY',premultiplyAlpha:'none',colorSpaceConversion:'none'}))))
    .then(results=>{
      const copies=results.filter(result=>result.status==='fulfilled').map(result=>result.value);
      if(disposed||copies.length!==2){copies.forEach(bitmap=>bitmap.close());if(!disposed)fail();return;}
      const [bitmap,matte]=copies;
      try {worker.postMessage({type:'init',canvas:surface,image:bitmap,contour:matte,width,height},[surface,bitmap,matte]);}
      catch(_){copies.forEach(bitmap=>bitmap.close());fail();}
    }).catch(fail);
  return {
    transferred:true,
    resize(w,h){width=w;height=h;},
    draw(scan,light){lastFrame=[scan,light];return send();},
    dispose,
  };
};
})();
