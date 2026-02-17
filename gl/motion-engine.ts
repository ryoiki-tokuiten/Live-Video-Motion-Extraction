
import {
    vertexShaderSource,
    backgroundSubtractionFragmentSource,
    morphologyFragmentSource,
    outputFragmentSource
} from './shaders';

export interface MotionControls {
    detectionMode: 'color' | 'luminance';
    detectionThreshold: number;
    processingResolution: number;
    noiseReduction: number; // Handled via CSS blur or separate pass? CSS is faster/easier for pre-blur.
    adaptationRate: number;
    morphology: 'none' | 'open' | 'close';
    effect: 'classic' | 'colorBurn' | 'electricTrails' | 'heatmap' | 'chromatic';
    invert: boolean;
    persistence: number;
}

export class MotionEngine {
    private gl: WebGL2RenderingContext;
    private width: number = 0;
    private height: number = 0;

    private programs: {
        bgSub: WebGLProgram;
        morph: WebGLProgram;
        output: WebGLProgram;
    } | null = null;

    private textures: {
        video: WebGLTexture;
        mean: [WebGLTexture, WebGLTexture]; // Ping-pong
        variance: [WebGLTexture, WebGLTexture]; // Ping-pong
        mask: [WebGLTexture, WebGLTexture]; // Ping-pong for morphology
    } | null = null;

    private framebuffers: {
        bgSub: [WebGLFramebuffer, WebGLFramebuffer]; // Ping-pong
        morph: [WebGLFramebuffer, WebGLFramebuffer]; // Ping-pong
    } | null = null;

    private buffers: {
        quad: WebGLBuffer;
    } | null = null;

    private pingPongIndex = 0;
    private isInitialized = false;

    constructor(canvas: HTMLCanvasElement) {
        const gl = canvas.getContext('webgl2', {
            premultipliedAlpha: false,
            preserveDrawingBuffer: true // Needed for trails? Or just manual management.
        });
        if (!gl) {
            throw new Error('WebGL 2 not supported');
        }
        this.gl = gl;

        // Enable floating point textures for precision
        gl.getExtension('EXT_color_buffer_float');
        gl.getExtension('OES_texture_float_linear'); // Optional but good
    }

    public getGPUInfo(): string {
        const debugInfo = this.gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
            return this.gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        }
        return this.gl.getParameter(this.gl.RENDERER);
    }

    public init(width: number, height: number) {
        this.width = width;
        this.height = height;

        this.createPrograms();
        this.createBuffers();
        this.createTexturesAndFBOs();

        this.isInitialized = true;
    }

    public resize(width: number, height: number) {
        if (this.width !== width || this.height !== height) {
            this.width = width;
            this.height = height;
            this.createTexturesAndFBOs(); // Recreate textures
        }
    }

    public render(video: HTMLVideoElement, controls: MotionControls) {
        if (!this.isInitialized) return;

        const gl = this.gl;
        const idx = this.pingPongIndex;
        const nextIdx = (idx + 1) % 2;

        gl.viewport(0, 0, this.width, this.height);

        // 1. Update Video Texture (flip Y to match WebGL coordinate system)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures!.video);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); // Reset for internal textures

        // 2. Background Subtraction Pass
        gl.useProgram(this.programs!.bgSub);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers!.bgSub[nextIdx]);

        // Inputs
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures!.video);
        gl.uniform1i(gl.getUniformLocation(this.programs!.bgSub, 'u_image'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.textures!.mean[idx]);
        gl.uniform1i(gl.getUniformLocation(this.programs!.bgSub, 'u_backgroundMean'), 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.textures!.variance[idx]);
        gl.uniform1i(gl.getUniformLocation(this.programs!.bgSub, 'u_backgroundVariance'), 2);

        gl.uniform1f(gl.getUniformLocation(this.programs!.bgSub, 'u_adaptationRate'), controls.adaptationRate);
        // UI threshold (1-50) → shader threshold (0.1-5.0)
        gl.uniform1f(gl.getUniformLocation(this.programs!.bgSub, 'u_threshold'), controls.detectionThreshold / 10.0);
        gl.uniform1i(gl.getUniformLocation(this.programs!.bgSub, 'u_isColorMode'), controls.detectionMode === 'color' ? 1 : 0);
        gl.uniform1f(gl.getUniformLocation(this.programs!.bgSub, 'u_minVariance'), 0.05); // Simplified min variance

        // Draw Quad
        this.drawQuad();


        // 3. Morphology Pass (Optional)
        let currentMaskTex = this.textures!.mask[nextIdx]; // Written by bgSub MRT

        if (controls.morphology !== 'none') {
            // Open = Erode → Dilate, Close = Dilate → Erode
            // Ping-pong: Input(nextIdx) → Pass1 → Output(idx) → Pass2 → Output(nextIdx)

            gl.useProgram(this.programs!.morph);

            if (controls.morphology === 'open') {
                // Pass 1: Erode
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers!.morph[idx]); // Output to 'idx' texture
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, currentMaskTex);
                gl.uniform1i(gl.getUniformLocation(this.programs!.morph, 'u_image'), 0);
                gl.uniform2f(gl.getUniformLocation(this.programs!.morph, 'u_resolution'), this.width, this.height);
                gl.uniform1i(gl.getUniformLocation(this.programs!.morph, 'u_type'), 0); // Erode
                this.drawQuad();

                // Pass 2: Dilate
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers!.morph[nextIdx]); // Output back to 'nextIdx'
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.textures!.mask[idx]); // Read from 'idx'
                gl.uniform1i(gl.getUniformLocation(this.programs!.morph, 'u_image'), 0);
                gl.uniform1i(gl.getUniformLocation(this.programs!.morph, 'u_type'), 1); // Dilate
                this.drawQuad();
            } else if (controls.morphology === 'close') {
                // Pass 1: Dilate
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers!.morph[idx]);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, currentMaskTex);
                gl.uniform1i(gl.getUniformLocation(this.programs!.morph, 'u_image'), 0);
                gl.uniform2f(gl.getUniformLocation(this.programs!.morph, 'u_resolution'), this.width, this.height);
                gl.uniform1i(gl.getUniformLocation(this.programs!.morph, 'u_type'), 1); // Dilate
                this.drawQuad();

                // Pass 2: Erode
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers!.morph[nextIdx]);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.textures!.mask[idx]);
                gl.uniform1i(gl.getUniformLocation(this.programs!.morph, 'u_image'), 0);
                gl.uniform1i(gl.getUniformLocation(this.programs!.morph, 'u_type'), 0); // Erode
                this.drawQuad();
            }
        }


        // 4. Final Display Pass
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Screen
        gl.useProgram(this.programs!.output);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures!.video);
        gl.uniform1i(gl.getUniformLocation(this.programs!.output, 'u_video'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.textures!.mask[nextIdx]);
        gl.uniform1i(gl.getUniformLocation(this.programs!.output, 'u_mask'), 1);

        gl.uniform1i(gl.getUniformLocation(this.programs!.output, 'u_effect'),
            controls.effect === 'colorBurn' ? 1 :
                controls.effect === 'electricTrails' ? 2 :
                    controls.effect === 'heatmap' ? 3 :
                        controls.effect === 'chromatic' ? 4 : 0);
        gl.uniform1i(gl.getUniformLocation(this.programs!.output, 'u_invert'), controls.invert ? 1 : 0);
        gl.uniform2f(gl.getUniformLocation(this.programs!.output, 'u_resolution'), this.width, this.height);

        const isPersistence = controls.effect === 'electricTrails' || controls.effect === 'heatmap';

        if (isPersistence) {
            // Fade previous frame by drawing a semi-transparent black quad
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            // Dim the previous buffer: lower alpha = longer trails
            const fade = 1.0 - controls.persistence; // persistence 0.85 → fade 0.15
            gl.clearColor(0.0, 0.0, 0.0, fade);
            gl.clear(gl.COLOR_BUFFER_BIT);
        } else {
            gl.disable(gl.BLEND);
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }

        this.drawQuad();

        // 5. Cleanup / Swap
        this.pingPongIndex = nextIdx;
    }

    private drawQuad() {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers!.quad);
        gl.enableVertexAttribArray(0); // position
        gl.enableVertexAttribArray(1); // texCoord
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    private createPrograms() {
        this.programs = {
            bgSub: this.createProgram(vertexShaderSource, backgroundSubtractionFragmentSource),
            morph: this.createProgram(vertexShaderSource, morphologyFragmentSource),
            output: this.createProgram(vertexShaderSource, outputFragmentSource),
        };
    }

    private createProgram(vsSource: string, fsSource: string): WebGLProgram {
        const gl = this.gl;
        const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
        const program = gl.createProgram()!;
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program)!);
        }
        return program;
    }

    private compileShader(type: number, source: string): WebGLShader {
        const gl = this.gl;
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader)!);
        }
        return shader;
    }

    private createBuffers() {
        const gl = this.gl;
        const buffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        // Full screen quad: Pos(x,y), Tex(u,v)
        const data = new Float32Array([
            -1, -1, 0, 0,
            1, -1, 1, 0,
            -1, 1, 0, 1,
            1, 1, 1, 1,
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        this.buffers = { quad: buffer };
    }

    private createTexturesAndFBOs() {
        const gl = this.gl;
        const w = this.width;
        const h = this.height;

        const createTex = (format: number) => {
            const tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, format, w, h, 0, gl.RGBA, gl.FLOAT, null);
            // Note: gl.FLOAT requires EXT_color_buffer_float for RenderTargets.
            // Usually RGBA32F or RGBA16F.
            // Let's try RGBA16F for "insane speed" + decent precision. 
            // gl.RGBA16F is in WebGL2 + EXT_color_buffer_float.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return tex;
        };

        // Video Texture (standard RGBA8)
        const videoTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, videoTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // Init with null, uploaded every frame

        // Mean and Variance Textures (Float/Half-Float)
        // We use RGBA32F or RGBA16F.
        const createPingPong = () => [createTex(gl.RGBA32F), createTex(gl.RGBA32F)] as [WebGLTexture, WebGLTexture];

        this.textures = {
            video: videoTex,
            mean: createPingPong(),
            variance: createPingPong(),
            mask: createPingPong(),
        };

        // Framebuffers
        // BgSub FBOs: Attach Mean, Variance, Mask
        const createFBO = (idx: number) => {
            const fbo = gl.createFramebuffer()!;
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.textures!.mean[idx], 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.textures!.variance[idx], 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.textures!.mask[idx], 0);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]); // MRT
            return fbo;
        };

        this.framebuffers = {
            bgSub: [createFBO(0), createFBO(1)],
            morph: [gl.createFramebuffer()!, gl.createFramebuffer()!]
        };

        // Setup Morph FBOs (Attachment 0 is Mask)
        // Pass 1 (Erode): Writes to mask[idx] (using mask[nextIdx] as input)
        // OR simply reusable FBOs since we just attach textures dynamically?
        // Static FBO creation is faster.
        const setupMorphFBO = (fbo: WebGLFramebuffer, tex: WebGLTexture) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        };
        setupMorphFBO(this.framebuffers.morph[0], this.textures.mask[0]);
        setupMorphFBO(this.framebuffers.morph[1], this.textures.mask[1]);
    }
}
