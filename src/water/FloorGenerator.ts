import * as THREE from 'three';
import fullscreenVert from './shaders/fullscreen.vert.glsl?raw';
import floorFrag from './shaders/floor.frag.glsl?raw';

/**
 * Bakes the procedural pond floor into a tileable, mipmapped texture once at start-up,
 * so the per-frame water shader only pays for a texture lookup.
 */
export function bakeFloorTexture(renderer: THREE.WebGLRenderer, size = 1024, seed = 7.0): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
  });
  target.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const material = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert,
    fragmentShader: floorFrag,
    uniforms: {
      uSeed: { value: seed },
      uResolution: { value: new THREE.Vector2(size, size) },
    },
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(previous);

  material.dispose();
  geometry.dispose();
  return target;
}
