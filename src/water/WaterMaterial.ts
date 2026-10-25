import * as THREE from 'three';
import commonGlsl from './shaders/common.glsl?raw';
import causticsGlsl from './shaders/caustics.glsl?raw';
import surfaceVert from './shaders/waterSurface.vert.glsl?raw';
import surfaceFrag from './shaders/waterSurface.frag.glsl?raw';
import pebbleVert from './shaders/pebble.vert.glsl?raw';
import pebbleFrag from './shaders/pebble.frag.glsl?raw';

export const MAX_CURSORS = 10;
export const MAX_SHADOWS = 4;

/** Scene lighting shared by the water and pebbles. */
export const LIGHTING = {
  /** Direction towards the soft key light (used for caustics and crest highlights). */
  light: new THREE.Vector3(-0.25, 0.92, 0.3).normalize(),
  /** Direction towards the moon; its reflection appears in the upper part of the pond. */
  moon: new THREE.Vector3(-0.22, 0.8, -0.59).normalize(),
};

/** Colour and lighting presets for the water surface (all colours linear, before tone mapping). */
export interface WaterLook {
  skyZenith: [number, number, number];
  skyHorizon: [number, number, number];
  cloudColor: [number, number, number];
  sunColor: [number, number, number];
  sunDisc: number;
  /** 0..1: overhanging foliage silhouettes in the reflection. */
  canopy: number;
  absorb: [number, number, number];
  shallowColor: [number, number, number];
  deepColor: [number, number, number];
  floorLight: number;
  caustics: number;
  fresnelBase: number;
  glitter: number;
  foam: number;
  breeze: number;
  vignette: number;
  exposure: number;
}

export type LookName = 'day' | 'night';

export const LOOKS: Record<LookName, WaterLook> = {
  /** Bright open water: turquoise shallows, deep azure patches, sun glitter and white foam. */
  day: {
    skyZenith: [0.2, 0.42, 0.85],
    skyHorizon: [0.7, 0.82, 0.95],
    cloudColor: [0.25, 0.26, 0.28],
    sunColor: [1.0, 0.97, 0.9],
    sunDisc: 25,
    canopy: 0,
    absorb: [7.0, 3.0, 1.8],
    shallowColor: [0.0, 0.42, 0.78],
    deepColor: [0.0, 0.06, 0.3],
    floorLight: 0.6,
    caustics: 1.2,
    fresnelBase: 0.03,
    glitter: 2.5,
    foam: 0.9,
    breeze: 0.009,
    vignette: 0.85,
    exposure: 1.0,
  },
  /** The original moonlit pond: charcoal and midnight blue. */
  night: {
    skyZenith: [0.016, 0.024, 0.042],
    skyHorizon: [0.15, 0.18, 0.22],
    cloudColor: [0.05, 0.06, 0.075],
    sunColor: [0.95, 0.97, 1.0],
    sunDisc: 9,
    canopy: 1,
    absorb: [2.3, 1.15, 0.78],
    shallowColor: [0.0035, 0.0085, 0.0135],
    deepColor: [0.0035, 0.0085, 0.0135],
    floorLight: 0.5,
    caustics: 1,
    fresnelBase: 0.04,
    glitter: 1,
    foam: 0.12,
    breeze: 0.0035,
    vignette: 0.55,
    exposure: 1.15,
  },
};

export interface WaterMaterialOptions {
  floor: THREE.Texture;
  floorTile: number;
  depth: number;
  heightScale: number;
  look?: WaterLook;
}

export function applyLook(material: THREE.ShaderMaterial, look: WaterLook): void {
  const u = material.uniforms;
  u.uSkyZenith.value.set(...look.skyZenith);
  u.uSkyHorizon.value.set(...look.skyHorizon);
  u.uCloudColor.value.set(...look.cloudColor);
  u.uSunColor.value.set(...look.sunColor);
  u.uSunDisc.value = look.sunDisc;
  u.uCanopy.value = look.canopy;
  u.uAbsorb.value.set(...look.absorb);
  u.uShallowColor.value.set(...look.shallowColor);
  u.uDeepColor.value.set(...look.deepColor);
  u.uFloorLight.value = look.floorLight;
  u.uCaustics.value = look.caustics;
  u.uFresnelBase.value = look.fresnelBase;
  u.uGlitter.value = look.glitter;
  u.uFoam.value = look.foam;
  u.uBreeze.value = look.breeze;
  u.uVignette.value = look.vignette;
  u.uExposure.value = look.exposure;
}

export function createWaterMaterial(o: WaterMaterialOptions): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: `${commonGlsl}\n${surfaceVert}`,
    fragmentShader: `${commonGlsl}\n${causticsGlsl}\n${surfaceFrag}`,
    uniforms: {
      uDomain: { value: new THREE.Vector4(0, 0, 1, 1) },
      uHeight: { value: null },
      uSimTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uHeightScale: { value: o.heightScale },
      uFloor: { value: o.floor },
      uFloorTile: { value: o.floorTile },
      uStoneRelief: { value: 0.05 * o.floorTile },
      uDepth: { value: o.depth },
      uTime: { value: 0 },
      uLightDir: { value: LIGHTING.light.clone() },
      uMoonDir: { value: LIGHTING.moon.clone() },
      uCaustics: { value: 1 },
      uExposure: { value: 1.15 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCursors: { value: Array.from({ length: MAX_CURSORS }, () => new THREE.Vector4()) },
      uCursorCount: { value: 0 },
      uShadows: { value: Array.from({ length: MAX_SHADOWS }, () => new THREE.Vector4()) },
      uShadowCount: { value: 0 },
      uSkyZenith: { value: new THREE.Vector3() },
      uSkyHorizon: { value: new THREE.Vector3() },
      uCloudColor: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Vector3() },
      uSunDisc: { value: 0 },
      uCanopy: { value: 0 },
      uAbsorb: { value: new THREE.Vector3() },
      uShallowColor: { value: new THREE.Vector3() },
      uDeepColor: { value: new THREE.Vector3() },
      uFloorLight: { value: 0 },
      uFresnelBase: { value: 0.03 },
      uGlitter: { value: 1 },
      uFoam: { value: 0 },
      uBreeze: { value: 0 },
      uVignette: { value: 1 },
    },
  });
  applyLook(material, o.look ?? LOOKS.day);
  return material;
}

export function createPebbleMaterial(seed: number): THREE.ShaderMaterial {
  const tints = [new THREE.Color(0.2, 0.21, 0.22), new THREE.Color(0.17, 0.19, 0.22), new THREE.Color(0.24, 0.21, 0.18), new THREE.Color(0.3, 0.3, 0.29)];
  return new THREE.ShaderMaterial({
    vertexShader: pebbleVert,
    fragmentShader: pebbleFrag,
    uniforms: {
      uLightDir: { value: LIGHTING.light.clone() },
      uMoonDir: { value: LIGHTING.moon.clone() },
      uTint: { value: tints[Math.floor(seed * tints.length) % tints.length] },
      uSubmerge: { value: 0 },
      uOpacity: { value: 1 },
      uSeed: { value: seed },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}
