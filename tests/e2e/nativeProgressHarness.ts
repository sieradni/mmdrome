import { mount } from 'svelte'
import Harness from './NativeProgressHarness.svelte'
import { forwardNativePreloadProgress } from '../../src/lib/nativeLoadStatus'

Object.assign(window, { emitNativeProgress: forwardNativePreloadProgress })
mount(Harness, { target: document.body })
