"use client";

import { useEffect, useRef } from "react";

const vertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const fragmentShader = `
  precision highp float;

  uniform float uTime;
  uniform float uScroll;
  uniform vec2 uResolution;
  uniform vec2 uPointer;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.53;
    mat2 rotation = mat2(0.82, 0.57, -0.57, 0.82);
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise(p);
      p = rotation * p * 2.03 + 17.17;
      amplitude *= 0.49;
    }
    return value;
  }

  float softOrb(vec2 p, vec2 center, float radius) {
    return smoothstep(radius, 0.0, length(p - center));
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    p.x *= uResolution.x / max(uResolution.y, 1.0);

    float t = uTime * 0.075;
    vec2 warpA = vec2(
      fbm(p * 1.25 + vec2(t, -t * 0.7)),
      fbm(p * 1.2 + vec2(-t * 0.55, t * 0.8) + 6.3)
    );
    vec2 warpB = vec2(
      fbm(p * 1.7 + warpA * 2.1 + vec2(0.0, t)),
      fbm(p * 1.55 + warpA * 1.7 + vec2(t * 0.8, 8.2))
    );

    float stream = fbm(p * 2.1 + warpB * 2.6);
    float ridge = 1.0 - abs(stream * 2.0 - 1.0);
    ridge = pow(max(ridge, 0.0), 4.5);

    vec2 pointer = (uPointer * 2.0 - 1.0);
    pointer.x *= uResolution.x / max(uResolution.y, 1.0);
    float pointerGlow = softOrb(p, pointer, 0.72) * 0.55;

    float tealField = softOrb(p, vec2(-0.62 + sin(t * 1.7) * 0.22, 0.34), 1.08);
    float violetField = softOrb(p, vec2(0.72, -0.22 + cos(t * 1.3) * 0.24), 1.2);
    float amberField = softOrb(p, vec2(sin(t) * 0.35, 0.74), 0.8);

    vec3 teal = vec3(0.04, 0.92, 0.72);
    vec3 violet = vec3(0.52, 0.26, 1.0);
    vec3 amber = vec3(1.0, 0.63, 0.16);
    vec3 blue = vec3(0.08, 0.32, 1.0);

    vec3 color = vec3(0.0);
    color += mix(teal, blue, warpA.y) * tealField;
    color += violet * violetField * (0.62 + warpB.x * 0.45);
    color += amber * amberField * (0.42 + warpA.x * 0.38);
    color += mix(teal, violet, warpB.y) * ridge * 1.75;
    color += mix(amber, teal, warpA.x) * pointerGlow * (0.5 + ridge);

    float energy = max(max(tealField, violetField), amberField);
    float alpha = clamp((energy * 0.34 + ridge * 0.78 + pointerGlow * 0.34), 0.0, 0.9);
    alpha *= mix(1.0, 0.2, uScroll);
    color *= 0.5 + ridge * 1.65;

    gl_FragColor = vec4(color, alpha);
  }
`;

export function FlowField() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (reducedMotion || connection?.saveData) {
      mount.classList.add("flow-field--fallback");
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | undefined;

    const setup = async () => {
      const THREE = await import("three");
      if (disposed) return;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          powerPreference: "low-power",
        });
      } catch {
        if (!disposed) mount.classList.add("flow-field--fallback");
        return;
      }

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const uniforms = {
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPointer: { value: new THREE.Vector2(0.76, 0.3) },
      };
      const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const geometry = new THREE.PlaneGeometry(2, 2);
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      renderer.setClearColor(0x000000, 0);
      renderer.domElement.setAttribute("aria-hidden", "true");
      renderer.domElement.dataset.engine = "procure-flow";
      mount.appendChild(renderer.domElement);

      const drawingBufferSize = new THREE.Vector2();
      const resize = () => {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const compact = window.matchMedia("(max-width: 760px)").matches;
        const pixelBudgetDpr = Math.sqrt(
          1_800_000 / Math.max(width * height, 1),
        );
        const dpr = Math.max(
          0.7,
          Math.min(
            window.devicePixelRatio || 1,
            compact ? 1 : 1.5,
            pixelBudgetDpr,
          ),
        );
        renderer.setPixelRatio(dpr);
        renderer.setSize(width, height, false);
        renderer.getDrawingBufferSize(drawingBufferSize);
        uniforms.uResolution.value.copy(drawingBufferSize);
      };
      resize();

      let targetX = 0.76;
      let targetY = 0.3;
      const acceptsPointer = window.matchMedia("(pointer: fine)").matches;
      const onPointerMove = (event: PointerEvent) => {
        if (!acceptsPointer) return;
        targetX = event.clientX / Math.max(window.innerWidth, 1);
        targetY = 1 - event.clientY / Math.max(window.innerHeight, 1);
      };
      const onScroll = () => {
        uniforms.uScroll.value = Math.min(
          window.scrollY / Math.max(window.innerHeight * 0.8, 1),
          1,
        );
      };

      let previousFrameTime = performance.now();
      let frame = 0;
      let stopped = false;
      const render = () => {
        if (stopped || document.hidden) return;
        frame = window.requestAnimationFrame(render);
        const currentFrameTime = performance.now();
        uniforms.uTime.value =
          (uniforms.uTime.value +
            Math.min((currentFrameTime - previousFrameTime) / 1000, 0.05)) %
          4096;
        previousFrameTime = currentFrameTime;
        uniforms.uPointer.value.x +=
          (targetX - uniforms.uPointer.value.x) * 0.035;
        uniforms.uPointer.value.y +=
          (targetY - uniforms.uPointer.value.y) * 0.035;
        renderer.render(scene, camera);
      };
      const startRendering = () => {
        if (stopped || document.hidden || frame) return;
        previousFrameTime = performance.now();
        render();
      };
      const onVisibilityChange = () => {
        if (document.hidden) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        } else {
          startRendering();
        }
      };
      const onContextLost = (event: Event) => {
        event.preventDefault();
        window.cancelAnimationFrame(frame);
        frame = 0;
        if (!disposed) mount.classList.add("flow-field--fallback");
      };
      const onContextRestored = () => {
        if (!disposed) mount.classList.remove("flow-field--fallback");
        resize();
        startRendering();
      };

      window.addEventListener("resize", resize, { passive: true });
      window.visualViewport?.addEventListener("resize", resize, {
        passive: true,
      });
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("scroll", onScroll, { passive: true });
      document.addEventListener("visibilitychange", onVisibilityChange);
      renderer.domElement.addEventListener("webglcontextlost", onContextLost);
      renderer.domElement.addEventListener(
        "webglcontextrestored",
        onContextRestored,
      );
      onScroll();
      startRendering();

      cleanup = () => {
        stopped = true;
        window.cancelAnimationFrame(frame);
        window.removeEventListener("resize", resize);
        window.visualViewport?.removeEventListener("resize", resize);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("scroll", onScroll);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          onContextLost,
        );
        renderer.domElement.removeEventListener(
          "webglcontextrestored",
          onContextRestored,
        );
        geometry.dispose();
        material.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    };

    void setup().catch(() => {
      if (!disposed) mount.classList.add("flow-field--fallback");
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return (
    <div ref={mountRef} className="flow-field" aria-hidden="true" />
  );
}
