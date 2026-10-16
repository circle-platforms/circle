/** Thrown by the extension host and caught by an extension.

 * The desktop worker and the extension it loads import this one module, so
 * `instanceof` holds across that boundary. A second copy of the class would not.
 */
export class ExtensionError extends Error {}
