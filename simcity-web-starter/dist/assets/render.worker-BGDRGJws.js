let A=null,e=null;function oe(){const o=new Float32Array(16);return o[0]=1,o[5]=1,o[10]=1,o[15]=1,o}const m={position:new Float32Array([50,50,50]),target:new Float32Array([0,0,0]),up:new Float32Array([0,1,0]),fov:60,near:.1,far:2e3,viewMatrix:oe(),projMatrix:oe(),viewProjMatrix:oe()};let te=0,re=0,ce=150,de=45*Math.PI/180,ue=45*Math.PI/180;const j=new Map;let Y=null,_=null,ne=null,ie=null,ae=null,X=null,se=null,le=null;const Z=[];let h=null,B=null;const pe=1e3,E=100;let W=1,q=0,K=0;self.onmessage=async o=>{const t=o.data;switch(t.type){case"init":A=t.canvas,console.log("[Render] Canvas received, size:",A.width,"x",A.height),await xe(),Ce(),ve();break;case"set-era":t.era;break;case"mouse-move":Ae(t.x,t.y,t.buttons);break;case"mouse-up":te=0,re=0,X=null;break;case"preview-road":Le(t.segment);break;case"mouse-wheel":Re(t.deltaY);break;case"update-roads":Ue(t.data);break;case"update-buildings":Se(t.data);break;case"add-building":Me(t.data);break;case"update-zones":be(t.data);break;case"update-camera":t.position&&m.position.set(t.position),t.target&&m.target.set(t.target),he();break;case"resize":A&&(A.width=t.width,A.height=t.height);break}};async function xe(){if(!A){console.error("[Render] No canvas available");return}if(console.log("[Render] Initializing WebGL2..."),e=A.getContext("webgl2",{antialias:!0,alpha:!1,depth:!0,stencil:!1,powerPreference:"high-performance"}),!e){console.error("[Render] WebGL2 not supported");return}console.log("[Render] WebGL2 context created successfully"),e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL),e.disable(e.CULL_FACE),console.log("[Render] Creating shaders..."),h=me(Ne,Pe),B=me(Ee,Fe),console.log("[Render] Shaders created:",h?"basic OK":"basic FAILED",B?"building OK":"building FAILED"),we(),he(),console.log("[Render] Initial camera position:",m.position),console.log("[Render] Initial camera target:",m.target),console.log("[Render] View-projection matrix:",m.viewProjMatrix),console.log("[Render] Renderer initialized")}function me(o,t){if(!e)return null;const r=e.createShader(e.VERTEX_SHADER);if(e.shaderSource(r,o),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS))return console.error("Vertex shader compile error:",e.getShaderInfoLog(r)),null;const i=e.createShader(e.FRAGMENT_SHADER);if(e.shaderSource(i,t),e.compileShader(i),!e.getShaderParameter(i,e.COMPILE_STATUS))return console.error("Fragment shader compile error:",e.getShaderInfoLog(i)),null;const a=e.createProgram();return e.attachShader(a,r),e.attachShader(a,i),e.linkProgram(a),e.getProgramParameter(a,e.LINK_STATUS)?a:(console.error("Shader link error:",e.getProgramInfoLog(a)),null)}function Ae(o,t,r){if(r===2){const i=o-te,a=t-re;(te!==0||re!==0)&&(q+=i*1.5,K+=a*1.5)}te=o,re=t}function Re(o){W=Math.max(.3,Math.min(5,W*(1-o*.001)))}function we(){m.position[0]=m.target[0]+Math.sin(ue)*Math.cos(de)*ce,m.position[1]=m.target[1]+Math.sin(de)*ce,m.position[2]=m.target[2]+Math.cos(ue)*Math.cos(de)*ce,he()}function he(){if(O.lookAt(m.viewMatrix,m.position,m.target,m.up),A&&A.width>0&&A.height>0){const o=A.width/A.height;O.perspective(m.projMatrix,m.fov*Math.PI/180,o,m.near,m.far),O.multiply(m.viewProjMatrix,m.projMatrix,m.viewMatrix)}else{console.warn("[Render] Canvas not ready, using default aspect ratio");const o=16/9;O.perspective(m.projMatrix,m.fov*Math.PI/180,o,m.near,m.far),O.multiply(m.viewProjMatrix,m.projMatrix,m.viewMatrix)}}function Ce(){if(console.log("[Render] Creating ground mesh..."),!e){console.log("[Render] Cannot create ground mesh - no GL context");return}const o=[],t=[],r=[],i=[],a=pe/E;for(let l=0;l<=E;l++)for(let s=0;s<=E;s++){const c=(s-E/2)*a,g=(l-E/2)*a;o.push(c,0,g),t.push(0,1,0),r.push(s/E,l/E)}for(let l=0;l<E;l++)for(let s=0;s<E;s++){const c=l*(E+1)+s,g=c+1,u=c+E+1,n=u+1;i.push(c,g,n),i.push(c,n,u)}_=T(new Float32Array(o),new Float32Array(t),new Float32Array(r),new Uint32Array(i),new Uint8Array(i.length/3)),console.log("[Render] Ground mesh created:",_?"success":"failed"),_&&(console.log("[Render] Ground mesh vertices:",_.vertexCount),console.log("[Render] First few positions:",o.slice(0,9)),console.log("[Render] Grid bounds: X:",-50*a,"to",E/2*a),console.log("[Render] Grid bounds: Z:",-50*a,"to",E/2*a))}function T(o,t,r,i,a){if(!e)return null;const l=e.createVertexArray();e.bindVertexArray(l);const s=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,s),e.bufferData(e.ARRAY_BUFFER,o,e.STATIC_DRAW),e.vertexAttribPointer(0,3,e.FLOAT,!1,0,0),e.enableVertexAttribArray(0);const c=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,c),e.bufferData(e.ARRAY_BUFFER,t,e.STATIC_DRAW),e.vertexAttribPointer(1,3,e.FLOAT,!1,0,0),e.enableVertexAttribArray(1);const g=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,g),e.bufferData(e.ARRAY_BUFFER,r,e.STATIC_DRAW),e.vertexAttribPointer(2,2,e.FLOAT,!1,0,0),e.enableVertexAttribArray(2);const u=e.createBuffer();return e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,u),e.bufferData(e.ELEMENT_ARRAY_BUFFER,i,e.STATIC_DRAW),e.bindVertexArray(null),{positions:o,normals:t,uvs:r,indices:i,materialIds:a,vao:l,indexBuffer:u,vertexCount:i.length}}function Le(o){if(!e||!o||o.length<6)return;const t=[],r=[],i=[],a=[],l=o[0]-1e3,s=o[1]-1e3,c=o[2]-1e3,g=o[3]-1e3,u=o[4],n=c-l,d=g-s,C=Math.sqrt(n*n+d*d);if(C>0){const R=-d/C*u*.5,p=n/C*u*.5,v=.25;t.push(l-R,v,s-p),t.push(l+R,v,s+p),t.push(c+R,v,g+p),t.push(c-R,v,g-p);for(let L=0;L<4;L++)r.push(0,1,0);i.push(0,0,1,0,1,1,0,1),a.push(0,1,2,0,2,3),X=T(new Float32Array(t),new Float32Array(r),new Float32Array(i),new Uint32Array(a),new Uint8Array(2))}}function Ue(o){if(console.log("[Render] updateRoadMesh called, data keys:",Object.keys(o)),!e){console.log("[Render] No GL context");return}const t=o.roadSegments||o.segments,r=o.intersections||[];if(console.log("[Render] Road segments:",t==null?void 0:t.length,"intersections:",r==null?void 0:r.length),!t||t.length===0){console.log("[Render] No segments to render");return}Z.length=0;for(const n of r)Z.push({x:n.x-1e3,z:n.y-1e3,type:n.type,hasTrafficLight:n.type==="cross"||n.type==="complex",hasStopSign:n.type==="T"});console.log("[Render] Found",Z.length,"intersections");const i=[],a=[],l=[],s=[];let c=0;if(t instanceof Float32Array||Array.isArray(t)&&typeof t[0]=="number")for(let n=0;n<t.length;n+=6){const d=t[n]-1e3,C=t[n+1]-1e3,R=t[n+2]-1e3,p=t[n+3]-1e3,v=t[n+4],L=t[n+5];u(d,C,R,p,v,L)}else for(const n of t){const d=n.start.x-1e3,C=n.start.y-1e3,R=n.end.x-1e3,p=n.end.y-1e3,v=n.width,L=n.class;u(d,C,R,p,v,L)}function u(n,d,C,R,p,v){const L=C-n,F=R-d,S=Math.sqrt(L*L+F*F);if(S<1)return;const V=-F/S*p*.5,f=L/S*p*.5,w=.2,x=n*.013+d*.017,U=C*.013+R*.017,M=Math.sin(x)*.02+Math.sin(x*3.7)*.01,z=Math.sin(U)*.02+Math.sin(U*3.7)*.01,I=v===0?.1:0,N=Math.sin(n*.1+d*.15)*.5,P=Math.sin(C*.1+R*.15)*.5;i.push(n-V+N,w+I+M-.01,d-f+N*.3),i.push(n+V-N,w+I+M-.01,d+f-N*.3),i.push(C+V-P,w+I+z-.01,R+f-P*.3),i.push(C-V+P,w+I+z-.01,R-f+P*.3);for(let G=0;G<4;G++)a.push(0,1,0);const y=S/10;l.push(0,0,1,0,1,y,0,y);const b=c;s.push(b,b+1,b+2,b,b+2,b+3),c+=4}Y=T(new Float32Array(i),new Float32Array(a),new Float32Array(l),new Uint32Array(s),new Uint8Array(s.length/3)),ye()}function ye(){if(!e||Z.length===0)return;const o=[],t=[],r=[],i=[],a=[],l=[],s=[],c=[];let g=0,u=0;for(const n of Z){const R=n.x*.011+n.z*.013,p=Math.sin(R)*.01;o.push(n.x-12,.22+p,n.z-12,n.x+12,.22+p*.8,n.z-12,n.x+12,.22+p*.9,n.z+12,n.x-12,.22+p*1.1,n.z+12);for(let L=0;L<4;L++)t.push(0,1,0);r.push(0,0,1,0,1,1,0,1);const v=g;if(i.push(v,v+1,v+2,v,v+2,v+3),g+=4,n.hasTrafficLight){const V=[{x:n.x+12-2,z:n.z+12-2},{x:n.x-12+2,z:n.z-12+2}];for(const f of V){for(let x=0;x<8;x+=2){a.push(f.x-.3,.22+x,f.z-.3,f.x+.3,.22+x,f.z-.3,f.x+.3,.22+x+2,f.z-.3,f.x-.3,.22+x+2,f.z-.3);for(let M=0;M<4;M++)l.push(0,0,1);s.push(0,0,1,0,1,1,0,1);const U=u;c.push(U,U+1,U+2,U,U+2,U+3),u+=4}a.push(f.x-1.5,.22+8,f.z-1.5,f.x+1.5,.22+8,f.z-1.5,f.x+1.5,.22+8+1.5*2,f.z-1.5,f.x-1.5,.22+8+1.5*2,f.z-1.5);for(let x=0;x<4;x++)l.push(0,0,1);s.push(0,0,1,0,1,1,0,1);const w=u;c.push(w,w+1,w+2,w,w+2,w+3),u+=4}}}o.length>0&&(se=T(new Float32Array(o),new Float32Array(t),new Float32Array(r),new Uint32Array(i),new Uint8Array(i.length/3))),a.length>0&&(le=T(new Float32Array(a),new Float32Array(l),new Float32Array(s),new Uint32Array(c),new Uint8Array(c.length/3)))}function be(o){if(!e||!o)return;console.log("[Render] Updating zone mesh, data:",o);const t=o.parcelData,r=o.parcelVertices;if(!t||t.length===0){console.log("[Render] No parcel data to render");return}const i=[],a=[],l=[],s=[],c=[],g=[],u=[],n=[],d=[],C=[],R=[],p=[];let v=0,L=0,F=0,S=0;const V=t.length/9;console.log("[Render] Processing",V,"parcels");for(let f=0;f<V;f++){const w=t[f*9+1];t[f*9+2],t[f*9+6],t[f*9+7];const x=[];for(;S<r.length/2;){const y=r[S*2],b=r[S*2+1];if(y===-999999&&b===-999999){S++;break}x.push({x:y,y:b}),S++}if(x.length<3)continue;let U,M,z,I,N;if(w===0)U=i,M=a,z=l,I=s,N=v;else if(w===1)U=c,M=g,z=u,I=n,N=L;else if(w===2)U=d,M=C,z=R,I=p,N=F;else continue;for(const y of x){const b=y.x-1e3,G=y.y-1e3;U.push(b,.05,G),M.push(0,1,0),z.push((b+500)/1e3,(G+500)/1e3)}const P=N;for(let y=1;y<x.length-1;y++)I.push(P,P+y,P+y+1);w===0?v+=x.length:w===1?L+=x.length:w===2&&(F+=x.length)}console.log("[Render] Zone vertices - R:",i.length/3,"C:",c.length/3,"I:",d.length/3),i.length>0&&(ne=T(new Float32Array(i),new Float32Array(a),new Float32Array(l),new Uint32Array(s),new Uint8Array(s.length/3))),c.length>0&&(ie=T(new Float32Array(c),new Float32Array(g),new Float32Array(u),new Uint32Array(n),new Uint8Array(n.length/3))),d.length>0&&(ae=T(new Float32Array(d),new Float32Array(C),new Float32Array(R),new Uint32Array(p),new Uint8Array(p.length/3)))}function Se(o){if(!(!e||!o.buildings)){j.clear();for(const t of o.buildings){const r=T(t.positions,t.normals,t.uvs,t.indices,t.materialIds);r&&j.set(t.id,r)}}}function Me(o){if(!e||!o.meshData)return;const t=o.meshData,r=o.buildingId||o.parcelId,i=T(t.vertices,t.normals,t.uvs,t.indices,new Uint8Array(t.materialIds||new Array(t.vertices.length/3).fill(0)));i&&(j.set(r,i),console.log("[Render] Added building",r,"with",i.vertexCount,"vertices"))}let fe=performance.now(),ee=0,ge=0;function ve(){const o=performance.now();ee++,o-fe>=1e3&&(ge=ee*1e3/(o-fe),self.postMessage({type:"stats",fps:ge,zoom:W,panX:q,panY:K}),fe=o,ee=0),ee%10===0&&self.postMessage({type:"camera-update",zoom:W,panX:q,panY:K}),Ve(),self.requestAnimationFrame(ve)}let k=0;function D(){if(!A)return oe();const o=A.width/A.height,t=2*W/pe,r=Math.sqrt(3);return new Float32Array([r/2*t/o,.5*t,0,0,0,t,0,0,-r/2*t/o,.5*t,.001,0,q/A.width*2,-K/A.height*2,0,1])}function Ve(){if(!e||!A){k===0&&console.log("[Render] Draw called but gl or canvas missing"),k++;return}if(k===0&&(console.log("[Render] First frame drawing, canvas size:",A.width,"x",A.height),console.log("[Render] Initial isometric settings - Zoom:",W,"Pan:",q,K)),k++,A.width>0&&A.height>0)e.viewport(0,0,A.width,A.height);else return;if(e.clearColor(.7,.82,.92,1),e.clear(e.COLOR_BUFFER_BIT|e.DEPTH_BUFFER_BIT),k===1&&(console.log("[Render] Debug triangle exists:",!1),console.log("[Render] Ground mesh exists:",!!_),console.log("[Render] Basic shader exists:",!!h),console.log("[Render] Road mesh exists:",!!Y)),_&&h){k<=3&&console.log("[Render] Drawing ground mesh, vertices:",_.vertexCount),e.useProgram(h);const o=e.getUniformLocation(h,"uMVP"),t=e.getUniformLocation(h,"uColor"),r=D();e.uniformMatrix4fv(o,!1,r),e.uniform4f(t,.45,.55,.45,1),e.bindVertexArray(_.vao),e.drawElements(e.TRIANGLES,_.vertexCount,e.UNSIGNED_INT,0);const i=e.getError();i!==e.NO_ERROR&&k===2&&console.error("[Render] WebGL error after ground draw:",i)}if(h){e.useProgram(h);const o=e.getUniformLocation(h,"uMVP"),t=e.getUniformLocation(h,"uColor"),r=D();e.uniformMatrix4fv(o,!1,r),e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA),ne&&(e.uniform4f(t,.1,.7,.1,.4),e.bindVertexArray(ne.vao),e.drawElements(e.TRIANGLES,ne.vertexCount,e.UNSIGNED_INT,0)),ie&&(e.uniform4f(t,.1,.1,.7,.4),e.bindVertexArray(ie.vao),e.drawElements(e.TRIANGLES,ie.vertexCount,e.UNSIGNED_INT,0)),ae&&(e.uniform4f(t,.7,.5,.1,.4),e.bindVertexArray(ae.vao),e.drawElements(e.TRIANGLES,ae.vertexCount,e.UNSIGNED_INT,0)),e.disable(e.BLEND)}if(Y&&h){e.useProgram(h);const o=e.getUniformLocation(h,"uMVP"),t=e.getUniformLocation(h,"uColor"),r=D();e.uniformMatrix4fv(o,!1,r),e.uniform4f(t,.12,.12,.14,1),e.bindVertexArray(Y.vao),e.drawElements(e.TRIANGLES,Y.vertexCount,e.UNSIGNED_INT,0)}if(se&&h){e.useProgram(h);const o=e.getUniformLocation(h,"uMVP"),t=e.getUniformLocation(h,"uColor"),r=D();e.uniformMatrix4fv(o,!1,r),e.uniform4f(t,.14,.14,.16,1),e.bindVertexArray(se.vao),e.drawElements(e.TRIANGLES,se.vertexCount,e.UNSIGNED_INT,0)}if(le&&h){e.useProgram(h);const o=e.getUniformLocation(h,"uMVP"),t=e.getUniformLocation(h,"uColor"),r=D();e.uniformMatrix4fv(o,!1,r),e.uniform4f(t,.3,.3,.3,1),e.bindVertexArray(le.vao),e.drawElements(e.TRIANGLES,le.vertexCount,e.UNSIGNED_INT,0)}if(X&&h){e.useProgram(h);const o=e.getUniformLocation(h,"uMVP"),t=e.getUniformLocation(h,"uColor"),r=D();e.uniformMatrix4fv(o,!1,r),e.enable(e.BLEND),e.blendFunc(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA),e.uniform4f(t,.3,.8,1,.8),e.bindVertexArray(X.vao),e.drawElements(e.TRIANGLES,X.vertexCount,e.UNSIGNED_INT,0),e.disable(e.BLEND)}if(j.size>0){if(h){e.useProgram(h);const o=e.getUniformLocation(h,"uMVP"),t=e.getUniformLocation(h,"uColor"),r=D();e.uniformMatrix4fv(o,!1,r);for(const[i,a]of j){const l=i%3,c=[[.4,.5,.7,1],[.7,.4,.4,1],[.7,.6,.3,1]][l];e.uniform4f(t,c[0],c[1],c[2],c[3]),e.bindVertexArray(a.vao),e.drawElements(e.TRIANGLES,a.vertexCount,e.UNSIGNED_INT,0)}}else if(B){e.useProgram(B);const o=e.getUniformLocation(B,"uMVP"),t=e.getUniformLocation(B,"uView"),r=e.getUniformLocation(B,"uLightDir"),i=e.getUniformLocation(B,"uBaseColor"),a=D();e.uniformMatrix4fv(o,!1,a),e.uniformMatrix4fv(t,!1,m.viewMatrix),e.uniform3f(r,.3,-.7,.5);for(const[l,s]of j){const c=l*137.5%360,g=Ie(c/360,.2,.6);e.uniform4f(i,g[0],g[1],g[2],1),e.bindVertexArray(s.vao),e.drawElements(e.TRIANGLES,s.vertexCount,e.UNSIGNED_INT,0)}}}e.bindVertexArray(null)}function Ie(o,t,r){let i,a,l;{const s=(u,n,d)=>(d<0&&(d+=1),d>1&&(d-=1),d<.16666666666666666?u+(n-u)*6*d:d<.5?n:d<.6666666666666666?u+(n-u)*(.6666666666666666-d)*6:u),c=r+t-r*t,g=2*r-c;i=s(g,c,o+1/3),a=s(g,c,o),l=s(g,c,o-1/3)}return[i,a,l]}const H={cross:(o,t)=>new Float32Array([o[1]*t[2]-o[2]*t[1],o[2]*t[0]-o[0]*t[2],o[0]*t[1]-o[1]*t[0]]),subtract:(o,t)=>new Float32Array([o[0]-t[0],o[1]-t[1],o[2]-t[2]]),normalize:o=>{const t=Math.sqrt(o[0]*o[0]+o[1]*o[1]+o[2]*o[2]);return new Float32Array([o[0]/t,o[1]/t,o[2]/t])}},O={lookAt:(o,t,r,i)=>{const a=H.normalize(H.subtract(t,r)),l=H.normalize(H.cross(i,a)),s=H.cross(a,l);o[0]=l[0],o[1]=s[0],o[2]=a[0],o[3]=0,o[4]=l[1],o[5]=s[1],o[6]=a[1],o[7]=0,o[8]=l[2],o[9]=s[2],o[10]=a[2],o[11]=0,o[12]=-l[0]*t[0]-l[1]*t[1]-l[2]*t[2],o[13]=-s[0]*t[0]-s[1]*t[1]-s[2]*t[2],o[14]=-a[0]*t[0]-a[1]*t[1]-a[2]*t[2],o[15]=1},perspective:(o,t,r,i,a)=>{const l=1/Math.tan(t/2),s=1/(i-a);o[0]=l/r,o[1]=0,o[2]=0,o[3]=0,o[4]=0,o[5]=l,o[6]=0,o[7]=0,o[8]=0,o[9]=0,o[10]=(a+i)*s,o[11]=-1,o[12]=0,o[13]=0,o[14]=2*a*i*s,o[15]=0},multiply:(o,t,r)=>{const i=t[0],a=t[1],l=t[2],s=t[3],c=t[4],g=t[5],u=t[6],n=t[7],d=t[8],C=t[9],R=t[10],p=t[11],v=t[12],L=t[13],F=t[14],S=t[15],V=r[0],f=r[1],w=r[2],x=r[3],U=r[4],M=r[5],z=r[6],I=r[7],N=r[8],P=r[9],y=r[10],b=r[11],G=r[12],Q=r[13],J=r[14],$=r[15];o[0]=i*V+a*U+l*N+s*G,o[1]=i*f+a*M+l*P+s*Q,o[2]=i*w+a*z+l*y+s*J,o[3]=i*x+a*I+l*b+s*$,o[4]=c*V+g*U+u*N+n*G,o[5]=c*f+g*M+u*P+n*Q,o[6]=c*w+g*z+u*y+n*J,o[7]=c*x+g*I+u*b+n*$,o[8]=d*V+C*U+R*N+p*G,o[9]=d*f+C*M+R*P+p*Q,o[10]=d*w+C*z+R*y+p*J,o[11]=d*x+C*I+R*b+p*$,o[12]=v*V+L*U+F*N+S*G,o[13]=v*f+L*M+F*P+S*Q,o[14]=v*w+L*z+F*y+S*J,o[15]=v*x+L*I+F*b+S*$}},Ne=`#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;

uniform mat4 uMVP;

out vec3 vNormal;
out vec2 vUV;

void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  vNormal = aNormal;
  vUV = aUV;
}
`,Pe=`#version 300 es
precision highp float;

in vec3 vNormal;
in vec2 vUV;

uniform vec4 uColor;

out vec4 fragColor;

void main() {
  // Check if this is likely a road (darker color)
  bool isRoad = uColor.r < 0.2 && uColor.g < 0.2;
  
  if (isRoad) {
    // Roads: Add realistic texture and procedural details
    vec3 roadColor = uColor.rgb;
    
    // Base asphalt texture with multi-octave noise
    float noise1 = fract(sin(dot(vUV * 100.0, vec2(12.9898, 78.233))) * 43758.5453);
    float noise2 = fract(sin(dot(vUV * 50.0, vec2(94.234, 37.873))) * 28493.2847);
    float noise3 = fract(sin(dot(vUV * 200.0, vec2(45.234, 91.187))) * 91847.3652);
    float combinedNoise = noise1 * 0.5 + noise2 * 0.3 + noise3 * 0.2;
    roadColor = mix(roadColor, roadColor * 1.3, combinedNoise * 0.15);
    
    // Procedural cracks
    float crackNoise = fract(sin(dot(floor(vUV * 30.0), vec2(21.98, 78.233))) * 43758.5453);
    float crack = step(0.95, crackNoise);
    float crackPattern = fract(sin(dot(vUV * 150.0, vec2(12.345, 67.890))) * 12345.6789);
    crack *= step(0.7, crackPattern);
    roadColor = mix(roadColor, roadColor * 0.3, crack * 0.4);
    
    // Procedural potholes and damage
    vec2 cellPos = floor(vUV * 20.0);
    float potholeRandom = fract(sin(dot(cellPos, vec2(127.1, 311.7))) * 43758.5453);
    if (potholeRandom > 0.92) {
      vec2 localUV = fract(vUV * 20.0);
      float dist = length(localUV - 0.5);
      float pothole = 1.0 - smoothstep(0.1, 0.3, dist);
      roadColor = mix(roadColor, roadColor * 0.2, pothole * 0.5);
    }
    
    // Procedural manholes
    vec2 manholeGrid = floor(vUV * vec2(3.0, 8.0));
    float manholeRandom = fract(sin(dot(manholeGrid, vec2(51.23, 73.41))) * 38274.2847);
    if (manholeRandom > 0.85) {
      vec2 manholeLocal = fract(vUV * vec2(3.0, 8.0));
      float manholeDist = length(manholeLocal - 0.5);
      float manholeRing = smoothstep(0.15, 0.2, manholeDist) * (1.0 - smoothstep(0.25, 0.3, manholeDist));
      float manholeCenter = 1.0 - smoothstep(0.0, 0.15, manholeDist);
      roadColor = mix(roadColor, vec3(0.15, 0.15, 0.15), manholeRing * 0.8);
      roadColor = mix(roadColor, vec3(0.1, 0.1, 0.1), manholeCenter * 0.9);
    }
    
    // Oil stains and dark patches
    float stainNoise = fract(sin(dot(floor(vUV * 10.0), vec2(92.34, 28.51))) * 73829.234);
    if (stainNoise > 0.88) {
      vec2 stainLocal = fract(vUV * 10.0);
      float stainShape = smoothstep(0.6, 0.2, length(stainLocal - 0.5));
      stainShape *= fract(sin(dot(vUV * 40.0, vec2(83.23, 19.87))) * 9183.2847);
      roadColor = mix(roadColor, roadColor * 0.5, stainShape * 0.3);
    }
    
    // Tire tracks and wear patterns
    float trackPos1 = smoothstep(0.28, 0.32, vUV.x) * (1.0 - smoothstep(0.34, 0.38, vUV.x));
    float trackPos2 = smoothstep(0.62, 0.66, vUV.x) * (1.0 - smoothstep(0.68, 0.72, vUV.x));
    float tracks = max(trackPos1, trackPos2);
    roadColor = mix(roadColor, roadColor * 0.85, tracks * 0.2);
    
    // Lane markings with wear
    float centerLine = abs(vUV.x - 0.5) < 0.012 ? 1.0 : 0.0;
    float dashPattern = step(0.5, fract(vUV.y * 2.5));
    float lineWear = fract(sin(dot(vUV * 100.0, vec2(73.234, 28.873))) * 18374.234);
    centerLine *= dashPattern * (0.3 + lineWear * 0.7);
    roadColor = mix(roadColor, vec3(0.85, 0.85, 0.75), centerLine * 0.5);
    
    // Edge lines with damage
    float edgeLine = (vUV.x < 0.04 || vUV.x > 0.96) ? 1.0 : 0.0;
    float edgeWear = fract(sin(dot(vUV * 80.0, vec2(43.234, 98.873))) * 28374.234);
    edgeLine *= (0.4 + edgeWear * 0.6);
    roadColor = mix(roadColor, vec3(0.75, 0.75, 0.65), edgeLine * 0.25);
    
    // Edge crumbling
    float edgeCrumble = (vUV.x < 0.08 || vUV.x > 0.92) ? 1.0 : 0.0;
    float crumbleNoise = fract(sin(dot(vUV * 200.0, vec2(127.234, 48.873))) * 48274.234);
    edgeCrumble *= step(0.6, crumbleNoise);
    roadColor = mix(roadColor, roadColor * 0.6, edgeCrumble * 0.3);
    
    // Overall weathering based on position
    float weathering = noise1 * 0.1 + 0.9;
    roadColor *= weathering;
    
    fragColor = vec4(roadColor, 1.0);
  } else {
    // Ground: Grid pattern
    float minorGridScale = 20.0;
    float majorGridScale = 4.0;
    
    vec2 minorGrid = fract(vUV * minorGridScale);
    vec2 majorGrid = fract(vUV * majorGridScale);
    
    float lineWidth = 0.015;
    float minorLineStrength = 0.0;
    if (minorGrid.x < lineWidth || minorGrid.x > 1.0 - lineWidth) minorLineStrength = 1.0;
    if (minorGrid.y < lineWidth || minorGrid.y > 1.0 - lineWidth) minorLineStrength = 1.0;
    
    float majorLineWidth = 0.025;
    float majorLineStrength = 0.0;
    if (majorGrid.x < majorLineWidth || majorGrid.x > 1.0 - majorLineWidth) majorLineStrength = 1.0;
    if (majorGrid.y < majorLineWidth || majorGrid.y > 1.0 - majorLineWidth) majorLineStrength = 1.0;
    
    vec3 baseColor = uColor.rgb;
    vec3 minorGridColor = baseColor * 0.9;
    vec3 majorGridColor = baseColor * 0.75;
    
    vec3 finalColor = baseColor;
    finalColor = mix(finalColor, minorGridColor, minorLineStrength * 0.3);
    finalColor = mix(finalColor, majorGridColor, majorLineStrength * 0.5);
    
    fragColor = vec4(finalColor, uColor.a);
  }
}
`,Ee=`#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;

uniform mat4 uMVP;
uniform mat4 uView;

out vec3 vNormal;
out vec2 vUV;
out vec3 vWorldPos;

void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  vNormal = aNormal;
  vUV = aUV;
  vWorldPos = aPosition;
}
`,Fe=`#version 300 es
precision highp float;

in vec3 vNormal;
in vec2 vUV;
in vec3 vWorldPos;

uniform vec3 uLightDir;
uniform vec4 uBaseColor;

out vec4 fragColor;

void main() {
  vec3 normal = normalize(vNormal);
  float NdotL = max(dot(normal, -normalize(uLightDir)), 0.0);
  
  // Simple diffuse lighting
  vec3 diffuse = uBaseColor.rgb * (0.3 + 0.7 * NdotL);
  
  // Add some variation based on height
  float heightVar = smoothstep(0.0, 50.0, vWorldPos.y) * 0.1;
  diffuse = mix(diffuse, diffuse * 1.2, heightVar);
  
  // Simple window pattern
  float windowPattern = step(0.7, sin(vUV.x * 20.0) * sin(vUV.y * 30.0));
  diffuse = mix(diffuse, diffuse * 0.3, windowPattern * 0.5);
  
  fragColor = vec4(diffuse, uBaseColor.a);
}
`;
