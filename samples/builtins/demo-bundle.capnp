using Workerd = import "/workerd/workerd.capnp";

const bundle :Workerd.Worker.BuiltinsBundle = (
  modules = [
    ( name = "demo:secrets", src = embed "secrets.js" ),
  ]
);
