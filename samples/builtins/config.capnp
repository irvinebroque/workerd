using Workerd = import "/workerd/workerd.capnp";
using DemoBundle = import "demo-bundle.capnp";

const helloWorldExample :Workerd.Config = (
  services = [ (name = "main", worker = .helloWorld) ],
  sockets = [ ( name = "http", address = "*:8080", http = (), service = "main" ) ],
  builtins = [ DemoBundle.bundle ],
);

const helloWorld :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "worker.js")
  ],
  compatibilityDate = "2022-09-16",
);
