import { useRef, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'

/**
 * The reactor.
 *
 * Modelled on the JARVIS: A Second Screen Experience interface rather than on
 * the suit HUD, because that is the thing this app actually is — an assistant
 * you talk to, sitting idle and listening, not a targeting display. That
 * interface is one big COMPLETE ring: a soft teal torus with a dusty, eroded
 * outer edge and a finely textured disc inside it, on near-black. There is no
 * compass, there are no gauges, and nothing is a broken arc.
 *
 * It is drawn as a single camera-facing plane with a polar fragment shader
 * rather than as geometry. Everything here is a function of radius and angle,
 * which is exactly what a shader is good at, and it means the eroded edge is
 * real per-pixel turbulence instead of a displaced mesh pretending to be a
 * ring — which is how the old build ended up with a lumpy sphere.
 */

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragment = /* glsl */ `
  uniform vec3  uColor;
  uniform vec3  uHot;
  uniform float uLevel;
  uniform float uPhase;
  uniform float uOpen;
  uniform float uZoom;
  uniform float uIntensity;
  uniform float uStyle;

  varying vec2 vUv;

  // -- value noise + fbm ----------------------------------------------------
  vec2 hash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(dot(hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
          dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
      mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
          dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
      u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  // A soft complete circle at radius r0, w wide.
  float band(float r, float r0, float w) {
    return exp(-pow((r - r0) / w, 2.0));
  }

  #define TAU 6.28318530718

  void main() {
    // The shader field is scaled up so the ring sits in the middle of the
    // frame with dark margin around it — the reference disc, not something that
    // fills the screen edge to edge. Angle is scale-invariant, so the erosion
    // pattern is untouched.
    vec2 p = (vUv * 2.0 - 1.0) * uZoom;
    float r = length(p);
    float a = atan(p.y, p.x);

    // Sampling the turbulence on the unit circle rather than on p keeps it
    // continuous across the -pi/pi seam, which a plain atan lookup is not.
    vec2 ring = vec2(cos(a), sin(a));

    // -- the main ring ------------------------------------------------------
    // Its radius wanders on two scales, so the outline is never a clean
    // geometric circle — this dusty, breathing edge is the whole character of
    // the thing. The slow term drifts; the fine term shivers.
    float wob   = fbm(ring * 2.6 + vec2(uPhase * 0.22, 0.0)) * 0.055;
    float grain = fbm(ring * 9.0 - vec2(uPhase * 0.4, 0.0)) * 0.020;
    float R = 0.74 + wob + grain + uLevel * 0.03;

    // Erosion: the outer boundary is eaten away in patches, so the ring reads
    // as something luminous and unstable rather than as a drawn stroke.
    float erode = smoothstep(-0.25, 0.35, fbm(ring * 5.0 + vec2(uPhase * 0.5, 3.0)));

    // -- style ---------------------------------------------------------------
    // Weights on the terms that already exist rather than three shaders or
    // three meshes. Every k below is exactly 1.0 and the body fill is exactly
    // 0.0 at uStyle 0, so 'ring' is the authored look untouched, term for term.
    //
    // 'sphere' fills the interior and lets the outline go soft, which is the
    // whole difference between a body and a drawn circle. 'wire' does the
    // opposite: it keeps only the things that are genuinely lines — the
    // concentric hairlines and the polar weave — and drops the washes and the
    // glow that were filling the space between them.
    float wSphere = clamp(1.0 - abs(uStyle - 1.0), 0.0, 1.0);
    float wWire   = clamp(1.0 - abs(uStyle - 2.0), 0.0, 1.0);

    float kOutline = mix(1.0, 0.45, wSphere) * mix(1.0, 0.70, wWire);
    float kDust    = mix(1.0, 0.30, wSphere) * mix(1.0, 0.80, wWire);
    float kLines   = mix(1.0, 0.35, wSphere) * mix(1.0, 3.00, wWire);
    float kMesh    = mix(1.0, 0.60, wSphere) * mix(1.0, 2.60, wWire);
    float kWash    = mix(1.0, 1.60, wSphere) * mix(1.0, 0.00, wWire);
    float kGlow    = mix(1.0, 2.20, wSphere) * mix(1.0, 0.30, wWire);

    float outer = band(r, R, 0.030) * (0.45 + erode * 0.6);
    // A second, tighter pass just inside gives the ring an inner wall, which is
    // what makes it read as a tube seen slightly from the front.
    float wall  = band(r, R - 0.055, 0.020) * 0.5;
    // A fine bright filament riding the outer edge.
    float edge  = band(r, R + 0.004, 0.007) * (0.5 + uLevel * 0.45);

    // Dust: a scatter of bright motes clinging to the outer edge, densest right
    // at the rim and thinning outward, so the ring dissolves into grains rather
    // than ending at a line. This is the single most reference-accurate detail.
    float speck = fbm(ring * 46.0 + vec2(uPhase * 0.15, 11.0));
    speck = pow(max(speck, 0.0), 3.0);
    float dust = speck * band(r, R + 0.028, 0.055) * (1.4 + uLevel);

    // -- radar sweep --------------------------------------------------------
    // A soft luminous wedge travelling around the ring, leaving a fading wake
    // behind it — the one moving element the eye locks onto. Its wake also
    // rekindles the dust it passes, so the edge glitters in its path.
    float sweepA = mod(uPhase * 0.55, TAU);
    float dA = mod(a - sweepA + TAU + 3.14159, TAU) - 3.14159; // signed, wrapped
    // Both edges eased. A hard step on the leading edge cuts the wake off with
    // a visible radial seam, which reads as a rendering fault rather than as a
    // sweep — it was the one artefact in the whole ring.
    float wake = smoothstep(-2.6, -0.15, dA) * (1.0 - smoothstep(0.0, 0.22, dA));
    float radar = wake * band(r, R - 0.02, 0.075) * (0.55 + uLevel * 0.45);

    // -- concentric hairlines inside ---------------------------------------
    float lines =
        band(r, 0.615, 0.0035) * 0.45
      + band(r, 0.560, 0.0030) * 0.28
      + band(r, 0.470, 0.0035) * 0.36;

    // -- the textured core disc --------------------------------------------
    // Two counter-rotating polar meshes, dense enough to read as a woven
    // membrane rather than as stripes. The counter-rotation keeps it alive
    // without ever resolving into a direction the eye can follow.
    float m1 = (sin(a * 96.0 + uPhase * 0.6) * 0.5 + 0.5)
             * (sin(r * 210.0) * 0.5 + 0.5);
    float m2 = (sin(a * 60.0 - uPhase * 0.4) * 0.5 + 0.5)
             * (sin(r * 150.0 - uPhase) * 0.5 + 0.5);
    float mesh = mix(m1, m2, 0.5);
    float core = smoothstep(0.40, 0.36, r);
    float coreTex = core * (0.04 * kWash + mesh * 0.12 * kMesh) * (0.55 + uLevel * 0.9);
    // The disc's own soft rim.
    float coreEdge = band(r, 0.385, 0.010) * (0.55 + uLevel * 0.5);

    // A slow pulse rippling out through the core, the reactor's heartbeat.
    float pulse = band(r, fract(uPhase * 0.08) * 0.40, 0.020) * core * 0.45;

    // -- inner glow ---------------------------------------------------------
    float bloom = exp(-r * 3.4) * (0.16 + uLevel * 0.34);

    // The one term with no counterpart in the ring: a solid interior out to the
    // wandering rim, so the sphere is lit all the way across instead of being a
    // hoop with a textured disc floating in the middle of it.
    float bodyFill = wSphere * smoothstep(R + 0.02, R - 0.32, r)
                   * (0.10 + uLevel * 0.10);

    float v = (outer + wall + edge + coreEdge) * kOutline
            + dust * kDust
            + radar
            + lines * kLines
            + coreTex + pulse
            + bloom * kGlow
            + bodyFill;

    // The moving highlights run hot; the body of the ring keeps its hue.
    vec3 col = mix(uColor, uHot,
      clamp(edge * 1.3 + radar * 0.7 + pulse * 0.5 + dust * 0.4, 0.0, 1.0));

    // Radial reveal on power-up: the ring assembles from the centre outward.
    v *= smoothstep(0.0, 0.35, uOpen - r * 0.45);

    // Brightness authority for the whole orb, applied last so it scales the
    // finished image rather than any one term. 1.0 is the authored look.
    v *= uIntensity;

    gl_FragColor = vec4(col * v, v);
  }
`

/** The plane's half-width in world units. */
const HALF = 2.7
/** Radius, in the shader's own field units, at which the ring is drawn. */
const RING_R = 0.74
/**
 * Ring diameter as a fraction of the SHORTER viewport dimension.
 *
 * Framing has to be driven by the viewport rather than by a constant, because
 * the plane is a fixed size in world units while the frame is not: the same
 * scale that leaves a comfortable margin on a 16:9 monitor runs the ring off
 * both edges of a portrait window.
 */
const FIT = 0.60

export function Core({ drive }: { drive: Drive }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const mesh = useRef<THREE.Mesh>(null)
  const viewport = useThree((s) => s.viewport)

  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color('#19c4c4') },
      // Not white — a tinted highlight keeps the hue readable once bloom
      // stacks on top, instead of washing the ring out to a grey band.
      uHot: { value: new THREE.Color('#c9fdff') },
      uLevel: { value: 0 },
      uPhase: { value: 0 },
      uOpen: { value: 0 },
      // Field scale, recomputed every frame from the viewport — see below.
      uZoom: { value: 1.2 },
      // Both of these are deliberately identities at their defaults: the ring
      // renders byte for byte as it did before they existed.
      uIntensity: { value: 1 },
      uStyle: { value: 0 },
    }),
    [],
  )

  useFrame((_, dt) => {
    if (!mat.current || !mesh.current) return
    const u = mat.current.uniforms
    const r = drive.reactor

    mesh.current.visible = r.visible
    // Scaling the mesh rather than the shader's field. The ring sits at a fixed
    // radius inside a fixed quad with dark margin around it, so zooming the
    // field out would push the ring past the quad's own edge and cut it off in
    // a square; moving the quad takes the margin along with it.
    mesh.current.scale.setScalar(r.scale)

    const fit = Math.min(viewport.width, viewport.height)
    u.uZoom.value = (RING_R * HALF) / (FIT * 0.5 * fit)
    u.uLevel.value += (drive.level - u.uLevel.value) * Math.min(1, dt * 8)
    // Accumulated, not derived from elapsed time scaled by level — scaling the
    // clock would rewrite all the turbulence that has already happened, and the
    // edge would boil harder the longer the tab had been open. The spin
    // multiplier rides on the same accumulator for the same reason.
    u.uPhase.value += dt * (0.5 + u.uLevel.value * 0.7) * r.spin
    u.uOpen.value += (drive.open - u.uOpen.value) * Math.min(1, dt * 1.6)
    u.uIntensity.value = r.intensity
    u.uStyle.value = r.style
    ;(u.uColor.value as THREE.Color).lerp(r.color, Math.min(1, dt * 2.5))
  })

  return (
    <mesh ref={mesh} frustumCulled={false}>
      {/* One quad. The ring lives entirely in the fragment shader, so there is
          no geometry to tessellate and nothing to displace. */}
      <planeGeometry args={[5.4, 5.4]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={vertex}
        fragmentShader={fragment}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  )
}
