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

export interface WaterMaterialOptions {
  floor: THREE.Texture;
  floorTile: number;
  depth: number;
  heightScale: number;
}

export function createWaterMaterial(o: WaterMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
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
    },
  });
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
