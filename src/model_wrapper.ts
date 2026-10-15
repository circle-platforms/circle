import type { ChatModel, ModelRequest, ModelResponse } from './types.js';

/** Replace only completion; metadata/getters and methods keep the original model as their receiver. */
export function wrapModelCompletion<T extends ChatModel>(
  model: T,
  around: (
    request: ModelRequest,
    invoke: ChatModel['complete'],
  ) => Promise<ModelResponse>,
): T {
  const invoke: ChatModel['complete'] = (request) => model.complete(request);
  const complete: ChatModel['complete'] = (request) => around(request, invoke);
  const methods = new Map<
    PropertyKey,
    { original: Function; bound: Function }
  >();
  // A facade also supports frozen models: proxying their non-writable `complete`
  // directly would violate the Proxy get invariants when replacing that method.
  return new Proxy(Object.create(null) as T, {
    get(_target, property) {
      if (property === 'complete') return complete;
      const value = Reflect.get(model, property, model);
      if (typeof value !== 'function' || property === 'constructor')
        return value;
      const cached = methods.get(property);
      if (cached?.original === value) return cached.bound;
      const bound = value.bind(model);
      methods.set(property, { original: value, bound });
      return bound;
    },
    has: (_target, property) => Reflect.has(model, property),
    ownKeys: () => Reflect.ownKeys(model),
    getPrototypeOf: () => Reflect.getPrototypeOf(model),
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(model, property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    set: (_target, property, value) =>
      Reflect.set(model, property, value, model),
    defineProperty: (_target, property, descriptor) =>
      Reflect.defineProperty(model, property, descriptor),
    deleteProperty: (_target, property) =>
      Reflect.deleteProperty(model, property),
    preventExtensions: () => false,
  });
}
