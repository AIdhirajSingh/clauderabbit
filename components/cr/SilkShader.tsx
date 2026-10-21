"use client";

import { useEffect, useRef } from "react";

/**
 * The dark silk shader behind the footer, ported from the `startSilk` logic in
 * p3/Gate.dc.html (same fragment shader, footer palette
 * #0B0B0B #1C0A14 #5A0714 #8E1030, off 2, seed 3.2, scale 0.5).
 *
 * - One WebGL context per canvas, created once; the program is built once.
 * - The loop only runs while the canvas is on screen (IntersectionObserver)
 *   and the tab is visible.
 * - Under prefers-reduced-motion it draws a single still frame (t = 12) and
 *   redraws only on resize.
 * - If WebGL is unavailable, the shader fails to compile, or the context is
 *   lost, the canvas stays transparent and the footer's base colour shows.
 *   Nothing is logged.
 */

const FS = `precision highp float;
uniform vec2 res; uniform float t; uniform vec3 c0; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3;
uniform float mode; uniform float ang; uniform float wid; uniform float off; uniform float seed;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;
vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
i=mod289(i);vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
vec3 pal(float f){f=clamp(f,0.,1.);vec3 c=mix(c0,c1,smoothstep(0.,.35,f));c=mix(c,c2,smoothstep(.3,.7,f));return mix(c,c3,smoothstep(.65,1.,f));}
void main(){
 vec2 p=(gl_FragCoord.xy-.5*res)/res.y; vec2 uv=gl_FragCoord.xy/res;
 float tt=t*.07+seed;
 vec2 q=vec2(snoise(vec3(p*1.1,tt)),snoise(vec3(p*1.1+4.7,tt)));
 float n=snoise(vec3(p*1.4+q*.8,tt*1.4));
 vec3 col; float a;
 float dith=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)/255.;
 float ar=res.x/res.y;
 vec2 rr=vec2(p.x*.8-p.y*.6,p.x*.6+p.y*.8);
 float hh=snoise(vec3(rr.x*.8,rr.y*1.8,tt))+.45*snoise(vec3(rr*2.4+q,tt*1.3));
 float f=.5+.5*sin(rr.y*2.6+hh*1.5+t*.1);
 col=pal(f);
 float fold=sin(rr.y*8.+hh*3.6+t*.28);
 col=mix(col,c0,(.5-.5*fold)*.25);
 col+=pow(max(0.,fold),14.)*(off>1.5?.12:.3);
 col*=.98+.02*sin((rr.y+.05*hh)*170.);
 a=1.;
 col=mix(vec3(.043),col,.85*smoothstep(-.2,.9,uv.x+.2*n));
 gl_FragColor=vec4((col+dith)*a,a);
}`;

const VS = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";

const FOOTER = {
  pal: ["#0B0B0B", "#1C0A14", "#5A0714", "#8E1030"],
  off: 2,
  seed: 3.2,
  scale: 0.5,
} as const;

/** Time used for the single still frame under reduced motion (as drawn). */
const STILL_T = 12;

function hexToRgb(h: string): [number, number, number] {
  return [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

export function SilkShader({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = cv.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        powerPreference: "low-power",
      });
    } catch {
      gl = null;
    }
    if (!gl || gl.isContextLost()) return;
    const g = gl;

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = g.createShader(type);
      if (!sh) return null;
      g.shaderSource(sh, src);
      g.compileShader(sh);
      if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
        g.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(g.VERTEX_SHADER, VS);
    const fs = compile(g.FRAGMENT_SHADER, FS);
    const prog = g.createProgram();
    if (!vs || !fs || !prog) return;
    g.attachShader(prog, vs);
    g.attachShader(prog, fs);
    g.linkProgram(prog);
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
      g.deleteProgram(prog);
      g.deleteShader(vs);
      g.deleteShader(fs);
      return;
    }
    g.useProgram(prog);

    const buf = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, buf);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
    const loc = g.getAttribLocation(prog, "a");
    g.enableVertexAttribArray(loc);
    g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);

    const uRes = g.getUniformLocation(prog, "res");
    const uT = g.getUniformLocation(prog, "t");
    FOOTER.pal.forEach((h, i) => {
      g.uniform3fv(g.getUniformLocation(prog, `c${i}`), hexToRgb(h));
    });
    g.uniform1f(g.getUniformLocation(prog, "off"), FOOTER.off);
    g.uniform1f(g.getUniformLocation(prog, "seed"), FOOTER.seed);

    let still = false;
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      still = mq.matches;
    } catch {
      mq = null;
    }

    let raf = 0;
    let onScreen = false;
    let lost = false;
    const t0 = performance.now();

    const draw = () => {
      if (lost) return;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      const k = Math.min(1.5, window.devicePixelRatio || 1) * FOOTER.scale;
      const bw = Math.max(1, Math.round(w * k));
      const bh = Math.max(1, Math.round(h * k));
      if (cv.width !== bw || cv.height !== bh) {
        cv.width = bw;
        cv.height = bh;
      }
      g.viewport(0, 0, bw, bh);
      g.uniform2f(uRes, bw, bh);
      g.uniform1f(uT, still ? STILL_T : (performance.now() - t0) / 1000);
      g.drawArrays(g.TRIANGLES, 0, 3);
    };

    const shouldRun = () => !still && !lost && onScreen && document.visibilityState === "visible";

    const loop = () => {
      raf = 0;
      draw();
      if (shouldRun()) raf = requestAnimationFrame(loop);
    };

    const sync = () => {
      if (shouldRun()) {
        if (!raf) raf = requestAnimationFrame(loop);
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    // Draw the first frame immediately so the footer is never blank on reveal.
    draw();

    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        if (onScreen && still) draw();
        sync();
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(cv);

    const ro = new ResizeObserver(() => {
      if (!raf) draw();
    });
    ro.observe(cv);

    const onVis = () => sync();
    document.addEventListener("visibilitychange", onVis);

    const onMotion = (e: MediaQueryListEvent) => {
      still = e.matches;
      draw();
      sync();
    };
    mq?.addEventListener("change", onMotion);

    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      sync();
    };
    cv.addEventListener("webglcontextlost", onLost);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      mq?.removeEventListener("change", onMotion);
      cv.removeEventListener("webglcontextlost", onLost);
      if (!g.isContextLost()) {
        g.deleteBuffer(buf);
        g.deleteProgram(prog);
        g.deleteShader(vs);
        g.deleteShader(fs);
      }
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
