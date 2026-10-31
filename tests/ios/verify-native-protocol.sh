#!/bin/sh
set -eu

task_dir=$(mktemp -d "${TMPDIR:-/tmp}/piano-native.XXXXXX")
trap 'rm -r "$task_dir"' EXIT
swiftc -swift-version 6 -typecheck ios/PianoDuet/NativeInferenceProtocol.swift ios/PianoDuet/NativeInferenceBridge.swift
swiftc -swift-version 6 -parse-as-library ios/PianoDuet/NativeInferenceProtocol.swift tests/ios/NativeInferenceProtocolTests.swift -o "$task_dir/native-protocol"
"$task_dir/native-protocol"
