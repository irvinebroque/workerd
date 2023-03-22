using Workerd = import "/workerd/workerd.capnp";

const bundle :Workerd.BuiltinsBundle = (
  modules = [
    ( name = "demo:secrets", esModule = embed "secrets.js" ),
  ]
);
