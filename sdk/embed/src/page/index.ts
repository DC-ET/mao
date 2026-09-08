export type {
  PageElement, PageElementKind, PageOption, PageRect, PageSnapshot,
  PageAction, PageActionType, PageActionResult, PageBatchResult, PageEffect,
  PageObserveResult, PageScreenshot, PageToolError, PageToolName,
} from './types';
export { PAGE_TOOL_NAMES, isPageToolName, isMutatingAction } from './types';
export { scanPage, type ScanOptions, type ScanResult, type ScannedElement } from './scanner';
export { PageSnapshotManager, type ResolvedElement, type ResolveResult } from './snapshot-manager';
export { PageExecutor, waitForStable, type AuthorizeAction, type ExecuteOptions } from './executor';
export { PageAuthorization, type PageAuthorizationLevel, type PageConfirmRequest, type PageRisk } from './authorization';
export { capturePageScreenshot, type ScreenshotRenderer } from './screenshot';
export {
  PageEngine, type PageActionLogEntry, type PageEngineHooks, type PageHighlightTarget, type PageToolOutcome,
} from './engine';
