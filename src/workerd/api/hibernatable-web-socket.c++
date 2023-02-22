// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#include "hibernatable-web-socket.h"
#include <workerd/jsg/ser.h>
#include <workerd/io/hibernation-manager.h>

namespace workerd::api {

HibernatableWebSocketEvent::HibernatableWebSocketEvent()
    : ExtendableEvent("webSocketMessage") {};

jsg::Ref<WebSocket> HibernatableWebSocketEvent::getWebSocket(jsg::Lock& lock) {
  auto& manager = static_cast<HibernationManagerImpl&>(
      KJ_REQUIRE_NONNULL(
          KJ_REQUIRE_NONNULL(IoContext::current().getActor()).getHibernationManager()));
  auto& package = manager.package;
  auto& hibernatableWebSocket = KJ_REQUIRE_NONNULL(package.currentOccupant);
  if (hibernatableWebSocket.activeWebSocket == nullptr) {
    hibernatableWebSocket.unhibernate(lock);
  }
  return KJ_REQUIRE_NONNULL(hibernatableWebSocket.activeWebSocket).addRef();
}

jsg::Value HibernatableWebSocketEvent::getError(jsg::Lock& lock) {
  auto& a = KJ_REQUIRE_NONNULL(IoContext::current().getActor());
  auto& package = static_cast<HibernationManagerImpl&>(
      KJ_REQUIRE_NONNULL(a.getHibernationManager())).package;
  return lock.exceptionToJs(kj::mv(KJ_REQUIRE_NONNULL(package.e)));
}

kj::Promise<WorkerInterface::CustomEvent::Result> HibernatableWebSocketCustomEventImpl::run(
    kj::Own<IoContext_IncomingRequest> incomingRequest,
    kj::Maybe<kj::StringPtr> entrypointName) {
  // Mark the request as delivered because we're about to run some JS.
  auto& context = incomingRequest->getContext();
  incomingRequest->delivered();
  EventOutcome outcome = EventOutcome::OK;

  try {
    co_await context.run(
        [entrypointName=entrypointName, &context, params=kj::mv(params)]
        (Worker::Lock& lock) mutable {
      switch (params.type) {
        case HibernatableSocketParams::Type::TEXT:
          return lock.getGlobalScope().sendHibernatableWebSocketMessage(
              kj::mv(params.message),
              lock,
              lock.getExportedHandler(entrypointName, context.getActor()));
        case HibernatableSocketParams::Type::DATA:
          return lock.getGlobalScope().sendHibernatableWebSocketMessage(
              kj::mv(params.data),
              lock,
              lock.getExportedHandler(entrypointName, context.getActor()));
        case HibernatableSocketParams::Type::CLOSE:
          return lock.getGlobalScope().sendHibernatableWebSocketClose(
              kj::mv(params.closeReason),
              params.closeCode,
              lock,
              lock.getExportedHandler(entrypointName, context.getActor()));
        case HibernatableSocketParams::Type::ERROR:
          return lock.getGlobalScope().sendHibernatableWebSocketError(
              lock,
              lock.getExportedHandler(entrypointName, context.getActor()));
        KJ_UNREACHABLE;
      }
    });
  } catch(kj::Exception e) {
    if (auto desc = e.getDescription();
        !jsg::isTunneledException(desc) && !jsg::isDoNotLogException(desc)) {
      LOG_EXCEPTION("HibernatableWebSocketCustomEventImpl"_kj, e);
    }
    outcome = EventOutcome::EXCEPTION;
  }

  waitUntilTasks.add(incomingRequest->drain());

  co_return Result {
    .outcome = outcome,
  };
}

kj::Promise<WorkerInterface::CustomEvent::Result>
  HibernatableWebSocketCustomEventImpl::sendRpc(
    capnp::HttpOverCapnpFactory& httpOverCapnpFactory,
    capnp::ByteStreamFactory& byteStreamFactory,
    kj::TaskSet& waitUntilTasks,
    rpc::EventDispatcher::Client dispatcher) {
  KJ_UNIMPLEMENTED("HibernatableWebSocket event is never called via rpc.");
}

}  // namespace workerd::api
