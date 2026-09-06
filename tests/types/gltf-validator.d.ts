// The Khronos validator ships no types; the two calls the tests use.
declare module "gltf-validator" {
  export interface ValidationReport {
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: { code: string; message: string; severity: number; pointer?: string }[];
    };
    info: { totalTriangleCount: number; totalVertexCount: number; drawCallCount: number };
  }
  export function validateBytes(bytes: Uint8Array, options?: object): Promise<ValidationReport>;
  export function validateString(text: string, options?: object): Promise<ValidationReport>;
  const validator: {
    validateBytes: typeof validateBytes;
    validateString: typeof validateString;
    version: string;
  };
  export default validator;
}
