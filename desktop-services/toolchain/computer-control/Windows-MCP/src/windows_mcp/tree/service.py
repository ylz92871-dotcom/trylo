from __future__ import annotations
from windows_mcp.uia import Control, ComboBoxControl, DocumentControl, CheckBoxControl, EditControl, ButtonControl, SliderControl, ScrollPattern, WindowControl, ImageControl, Rect, ExpandCollapseState, ToggleState, PatternId, PropertyId, AccessibleRoleNames, TreeScope, ControlFromHandle, UIADeadElementError, from_com_error, TextPatternRangeEndpoint
from windows_mcp.tree.config import INTERACTIVE_CONTROL_TYPE_NAMES, DOCUMENT_CONTROL_TYPE_NAMES, INFORMATIVE_CONTROL_TYPE_NAMES, DEFAULT_ACTIONS, INTERACTIVE_ROLES, THREAD_MAX_RETRIES, STRUCTURAL_CONTROL_TYPE_NAMES
from windows_mcp.tree.views import TreeElementNode, ScrollElementNode, TextElementNode, Center, BoundingBox, TreeState, SemanticNode, UiaIdentity, UiaPatternAvailability, _prune_structural, _reverse_children_order
from windows_mcp.tree.cache_utils import (
    CacheRequestFactory,
    CachedControlHelper,
    is_uia_dead_element_error,
)
from windows_mcp.tree.budget import (
    MIN_WINDOW_SLICE_SECONDS,
    TreeElementBudget,
    resolve_max_capture_seconds,
    resolve_max_tree_elements,
    window_slice_seconds,
)
from windows_mcp.tree.utils import random_point_within_bounding_box
from windows_mcp.tree import ia2 as ia2_traversal
from typing import TYPE_CHECKING,Optional,Any
from time import sleep,perf_counter
from _ctypes import COMError
import logging
import weakref
import os

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Guaranteed wall-clock slice for the IA2 DOM walk of one browser window
# (seconds). See Tree._ia2_dom_walk.
IA2_MIN_TIME_BUDGET_SECONDS = 12.0

_COMTYPES_ORD_TYPEERROR_FRAGMENT = "ord() expected a character"
_COMTYPES_AUTOMATION_PATH_FRAGMENT = "comtypes/automation.py"


def _snapshot_profile_enabled() -> bool:
    value = os.getenv("WINDOWS_MCP_PROFILE_SNAPSHOT", "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _is_comtypes_variant_ord_typeerror(error: TypeError) -> bool:
    message = str(error)
    if _COMTYPES_ORD_TYPEERROR_FRAGMENT not in message:
        return False

    traceback_ref = error.__traceback__
    while traceback_ref is not None:
        filename = traceback_ref.tb_frame.f_code.co_filename.replace("\\", "/").lower()
        if filename.endswith(_COMTYPES_AUTOMATION_PATH_FRAGMENT):
            return True
        traceback_ref = traceback_ref.tb_next

    return False

if TYPE_CHECKING:
    from windows_mcp.desktop.service import Desktop

class Tree:
    def __init__(self,desktop:'Desktop'):
        self.desktop=weakref.proxy(desktop)
        self.screen_size=desktop.get_screen_size()
        self.dom:Optional[Control]=None
        self.dom_bounding_box:BoundingBox=None
        self.dom_is_ia2:bool=False
        self.screen_box=desktop.get_screen_box()
        self.tree_state=None
        self.element_budget=TreeElementBudget(
            resolve_max_tree_elements(),
            time_budget_seconds=resolve_max_capture_seconds(),
        )

    @staticmethod
    def _cached_uia_contract(
        node: Control,
    ) -> tuple[UiaIdentity, UiaPatternAvailability]:
        """Read identity and pattern flags from the existing cache only."""
        def cached(property_id: int) -> Any:
            try:
                return node.GetCachedPropertyValue(property_id)
            except Exception:
                return None

        runtime_raw = cached(PropertyId.RuntimeIdProperty)
        runtime_id = None
        if runtime_raw is not None:
            try:
                runtime_id = tuple(int(part) for part in runtime_raw)
            except (TypeError, ValueError):
                runtime_id = None

        point_raw = cached(PropertyId.ClickablePointProperty)
        clickable_point = None
        if point_raw is not None:
            try:
                if hasattr(point_raw, "x") and hasattr(point_raw, "y"):
                    clickable_point = (int(point_raw.x), int(point_raw.y))
                elif len(point_raw) >= 2:
                    clickable_point = (int(point_raw[0]), int(point_raw[1]))
            except (TypeError, ValueError):
                clickable_point = None

        def text_value(property_id: int) -> str | None:
            value = cached(property_id)
            return str(value) if value not in (None, "") else None

        identity = UiaIdentity(
            runtime_id=runtime_id,
            automation_id=text_value(PropertyId.AutomationIdProperty),
            class_name=text_value(PropertyId.ClassNameProperty),
            framework_id=text_value(PropertyId.FrameworkIdProperty),
            clickable_point=clickable_point,
        )
        patterns = UiaPatternAvailability(
            invoke=bool(cached(PropertyId.IsInvokePatternAvailableProperty)),
            toggle=bool(cached(PropertyId.IsTogglePatternAvailableProperty)),
            selection_item=bool(
                cached(PropertyId.IsSelectionItemPatternAvailableProperty)
            ),
            expand_collapse=bool(
                cached(PropertyId.IsExpandCollapsePatternAvailableProperty)
            ),
            value=bool(cached(PropertyId.IsValuePatternAvailableProperty)),
            range_value=bool(
                cached(PropertyId.IsRangeValuePatternAvailableProperty)
            ),
            text=bool(cached(PropertyId.IsTextPatternAvailableProperty)),
            scroll=bool(cached(PropertyId.IsScrollPatternAvailableProperty)),
            scroll_item=bool(
                cached(PropertyId.IsScrollItemPatternAvailableProperty)
            ),
            legacy_accessible=bool(
                cached(PropertyId.IsLegacyIAccessiblePatternAvailableProperty)
            ),
        )
        return identity, patterns


    def get_state(self,active_window_handle:int|None,other_windows_handles:list[int],use_dom:bool=False)->TreeState:
        # Reset DOM state to prevent leaks and stale data
        self.dom = None
        self.dom_bounding_box = None
        self.dom_is_ia2 = False
        # Fresh budget per capture — huge lists/grids (e.g. thousands of rows) must not
        # stall UI Automation or blow up the serialized response, and a slow UIA
        # provider (Chromium AX crawl) must not wedge the actor lane past every
        # caller's deadline. Both bounds degrade to an honestly-marked partial tree.
        self.element_budget = TreeElementBudget(
            resolve_max_tree_elements(),
            time_budget_seconds=resolve_max_capture_seconds(),
        )
        start_time = perf_counter()
        profile_enabled = _snapshot_profile_enabled()

        active_window_flag=False
        if active_window_handle:
            active_window_flag=True
            windows_handles=[active_window_handle]+other_windows_handles
        else:
            windows_handles=other_windows_handles

        interactive_nodes,scrollable_nodes,dom_informative_nodes,failed_handles,window_sem_nodes,abandoned_handles=self.get_window_wise_nodes(windows_handles=windows_handles,active_window_flag=active_window_flag,use_dom=use_dom)
        root_node=TreeElementNode(
            name="Desktop",
            control_type="PaneControl",
            bounding_box=self.screen_box,
            center=self.screen_box.get_center(),
            window_name="Desktop",
            metadata={}
        )
        if self.dom:
            try:
                scroll_pattern:ScrollPattern=self.dom.GetCachedPattern(PatternId.ScrollPattern, True)
                metadata={
                    'has_focused': self.dom.CachedHasKeyboardFocus if self.dom else False,
                    'horizontal_scrollable':scroll_pattern.HorizontallyScrollable if scroll_pattern else False,
                    'horizontal_scroll_percent':round(scroll_pattern.HorizontalScrollPercent,2) if scroll_pattern and scroll_pattern.HorizontallyScrollable else 0,
                    'vertical_scrollable':scroll_pattern.VerticallyScrollable if scroll_pattern else False,
                    'vertical_scroll_percent':round(scroll_pattern.VerticalScrollPercent,2) if scroll_pattern and scroll_pattern.VerticallyScrollable else 0,
                }
                dom_node=ScrollElementNode(**{
                    'name':'DOM',
                    'control_type':'DocumentControl',
                    'bounding_box':self.dom_bounding_box,
                    'center':self.dom_bounding_box.get_center(),
                    'window_name':'DOM',
                    'metadata':metadata
                })
            except Exception as e:
                logger.debug(f"Failed to get DOM scroll pattern: {e}")
                dom_node=None
        elif self.dom_is_ia2 and self.dom_bounding_box is not None:
            # Firefox / IA2 path — no UIA scroll pattern, so emit a stub ScrollElementNode
            # with scrolling disabled. Downstream consumers (Scrape) only need a truthy
            # dom_node and the bounding box.
            dom_node=ScrollElementNode(**{
                'name':'DOM',
                'control_type':'DocumentControl',
                'bounding_box':self.dom_bounding_box,
                'center':self.dom_bounding_box.get_center(),
                'window_name':'DOM',
                'metadata':{
                    'has_focused': False,
                    'horizontal_scrollable': False,
                    'horizontal_scroll_percent': 0,
                    'vertical_scrollable': False,
                    'vertical_scroll_percent': 0,
                }
            })
        else:
            dom_node=None
        # Build semantic tree: desktop → windows → structural/interactive/scrollable
        desktop_root = SemanticNode(control_type='Desktop', element_type='desktop', name='Desktop', window_name='Desktop')
        for win_node in window_sem_nodes:
            desktop_root.add_child(win_node)
        _prune_structural(desktop_root)

        # Detect if tree capture failed for any windows
        status = len(failed_handles) == 0 and len(abandoned_handles) == 0
        if failed_handles:
            logger.warning(f"[Tree] {len(failed_handles)} window(s) failed to capture — UI services may be loading")
        if abandoned_handles:
            # I-09: abandonment must be visible, never silent (Known-2 escape
            # hatch — per-window slices keep one hung window from starving
            # the windows queued behind it).
            logger.warning(
                "[Tree] %d window(s) failed/abandoned: %d abandoned after their "
                "per-window time slice (handles=%s) — raise "
                "WINDOWS_MCP_MAX_CAPTURE_SECONDS or WINDOWS_MCP_MAX_WINDOW_SECONDS",
                len(failed_handles) + len(abandoned_handles),
                len(abandoned_handles),
                abandoned_handles,
            )
        end_time = perf_counter()
        if self.element_budget.truncated:
            logger.warning(
                "[Tree] Capture truncated at %d elements (limit=%d) — some UI elements were "
                "not visited. Set WINDOWS_MCP_MAX_TREE_ELEMENTS to raise the limit.",
                self.element_budget.count,
                self.element_budget.limit,
            )
        if self.element_budget.time_truncated:
            logger.warning(
                "[Tree] Capture exceeded its %.1fs wall-clock budget — some UI elements "
                "were not visited (slow UIA provider). Set WINDOWS_MCP_MAX_CAPTURE_SECONDS "
                "to raise the limit.",
                resolve_max_capture_seconds(),
            )
        if profile_enabled:
            logger.info(
                "Snapshot tree profile: windows=%d active_window=%s interactive_nodes=%d scrollable_nodes=%d dom_nodes=%d failed_windows=%d abandoned_windows=%d total_ms=%.1f use_dom=%s truncated=%s",
                len(windows_handles),
                active_window_handle is not None,
                len(interactive_nodes),
                len(scrollable_nodes),
                len(dom_informative_nodes),
                len(failed_handles),
                len(abandoned_handles),
                (end_time - start_time) * 1000,
                use_dom,
                self.element_budget.truncated,
            )
        logger.info(f"[Tree] Tree State capture took {end_time - start_time:.2f} seconds")
        return TreeState(
            status=status,
            root_node=root_node,
            dom_node=dom_node,
            interactive_nodes=interactive_nodes,
            scrollable_nodes=scrollable_nodes,
            dom_informative_nodes=dom_informative_nodes,
            capture_sec=end_time - start_time,
            semantic_tree_root=desktop_root,
            truncated=self.element_budget.truncated,
            element_limit=self.element_budget.limit,
            time_truncated=self.element_budget.time_truncated,
        )

    def get_window_wise_nodes(self,windows_handles:list[int],active_window_flag:bool,use_dom:bool=False) -> tuple[list[TreeElementNode],list[ScrollElementNode],list[TextElementNode],list[int],list[SemanticNode],list[int]]:
        """Process windows sequentially to avoid COM apartment threading deadlock.

        UI Automation requires STA (Single-Threaded Apartment). Using ThreadPoolExecutor
        with worker threads that each call CoInitialize() creates multiple STA threads,
        causing cross-apartment marshaling deadlocks when the main thread also does
        COM operations (ControlFromHandle, is_window_browser). Sequential processing
        keeps all UIA COM calls in the main thread's STA.
        """
        interactive_nodes, scrollable_nodes, dom_informative_nodes = [], [], []
        failed_handles = []
        window_sem_nodes: list[SemanticNode] = []

        task_inputs = []
        for handle in windows_handles:
            is_browser = False
            try:
                temp_node = ControlFromHandle(handle)
                if active_window_flag and temp_node.ClassName == "Progman":
                    continue
                is_browser = self.desktop.is_window_browser(temp_node)
            except Exception:
                pass
            task_inputs.append((handle, is_browser))

        retry_counts = {handle: 0 for handle in windows_handles}
        abandoned_handles: list[int] = []
        total_windows = len(task_inputs)
        for index, (handle, is_browser) in enumerate(task_inputs):
            if self.element_budget.exhausted:
                logger.debug(
                    "[Tree] Capture budget exhausted (%d/%d elements, %.1fs time budget) — "
                    "skipping remaining windows",
                    self.element_budget.count,
                    self.element_budget.limit,
                    resolve_max_capture_seconds(),
                )
                abandoned_handles.extend(h for h, _ in task_inputs[index:])
                break
            # Known-2 escape hatch: each window gets a fair share of the
            # remaining capture budget (optionally capped via
            # WINDOWS_MCP_MAX_WINDOW_SECONDS). A hung or pathologically slow
            # window can therefore cost at most its own slice instead of
            # starving every window queued behind it.
            slice_seconds = window_slice_seconds(
                self.element_budget, total_windows - index
            )
            if (
                slice_seconds is not None
                and slice_seconds < MIN_WINDOW_SLICE_SECONDS
                and self.element_budget.time_remaining_seconds is not None
            ):
                # Below the floor a crawl cannot make meaningful progress, and
                # the shared clock cannot fund one — abandon this and all
                # remaining windows honestly instead of burning the budget on
                # doomed partial crawls. (A small slice configured explicitly
                # via WINDOWS_MCP_MAX_WINDOW_SECONDS is honored, not floored:
                # with no global deadline there is no shared clock to protect.)
                abandoned_handles.extend(h for h, _ in task_inputs[index:])
                logger.warning(
                    "[Tree] %d window(s) abandoned before crawl — remaining capture "
                    "budget %.1fs cannot fund a meaningful per-window slice (floor %.1fs)",
                    total_windows - index,
                    self.element_budget.time_remaining_seconds,
                    MIN_WINDOW_SLICE_SECONDS,
                )
                break
            self.element_budget.begin_window(slice_seconds)
            try:
                for attempt in range(THREAD_MAX_RETRIES + 1):
                    try:
                        result = self.get_nodes(handle, is_browser, wait_time=0.5 * (2 ** (attempt - 1)) if attempt > 0 else 0, use_dom=use_dom)
                        if self.element_budget.window_exhausted:
                            # The crawl returned, but only after burning its
                            # whole slice — the partial result is not honest
                            # to present as complete, so discard and record.
                            abandoned_handles.append(handle)
                            logger.warning(
                                "[Tree] Window handle %s abandoned after its per-window "
                                "time slice (%.1fs left) — partial crawl discarded",
                                handle,
                                self.element_budget.time_remaining_seconds or 0.0,
                            )
                            break
                        if result:
                            element_nodes, scroll_nodes, info_nodes, win_sem_node = result
                            interactive_nodes.extend(element_nodes)
                            scrollable_nodes.extend(scroll_nodes)
                            dom_informative_nodes.extend(info_nodes)
                            if win_sem_node is not None:
                                window_sem_nodes.append(win_sem_node)
                        break
                    except Exception as e:
                        retry_counts[handle] = attempt + 1
                        try:
                            window_name = ControlFromHandle(handle).Name
                        except Exception:
                            window_name = "Unknown"
                        logger.warning(
                            f"Error in processing window '{window_name}' (handle {handle}), "
                            f"retry attempt {retry_counts[handle]}/{THREAD_MAX_RETRIES}\nError: {e}"
                        )
                        if self.element_budget.window_exhausted:
                            # The retry family (UIA_E_ELEMENTNOTAVAILABLE & co.)
                            # gets no further retries once this window's slice
                            # is spent — that is the starvation Known-2 hit.
                            abandoned_handles.append(handle)
                            logger.warning(
                                "[Tree] Window '%s' (handle %s) abandoned after its "
                                "per-window time slice — no further retries",
                                window_name,
                                handle,
                            )
                            break
                        if attempt < THREAD_MAX_RETRIES:
                            wait_time = 0.5 * (2 ** attempt)
                            logger.debug(f"Retrying window {handle} in {wait_time}s...")
                            sleep(wait_time)
                        else:
                            logger.error(f"Task failed completely for handle {handle} after {THREAD_MAX_RETRIES} retries")
                            failed_handles.append(handle)
                            break
            finally:
                self.element_budget.end_window()

        return interactive_nodes, scrollable_nodes, dom_informative_nodes, failed_handles, window_sem_nodes, abandoned_handles

    def iou_bounding_box(self, window_box: Rect, element_box: Rect) -> BoundingBox:
        clipped = element_box.intersect(window_box).intersect(self.screen_box)
        if clipped.right > clipped.left and clipped.bottom > clipped.top:
            return BoundingBox(
                left=clipped.left,
                top=clipped.top,
                right=clipped.right,
                bottom=clipped.bottom,
                width=clipped.width(),
                height=clipped.height()
            )
        return BoundingBox(left=0, top=0, right=0, bottom=0, width=0, height=0)

    def _append_word_nodes(self, word_elements:list[tuple[str,Rect]], reference_box:Rect, window_name:str,
                            target_nodes:list[TreeElementNode], current_semantic_node:'Optional[SemanticNode]'=None):
        """Append one interactive `TreeElementNode` (control_type='Word') per (word, rect) pair."""
        for word, rect in word_elements:
            if not self.element_budget.try_consume():
                break
            bounding_box = self.iou_bounding_box(reference_box, rect)
            if bounding_box.width <= 0 or bounding_box.height <= 0:
                continue
            center = bounding_box.get_center()
            word_node = TreeElementNode(**{
                'name':word,
                'control_type':'Word',
                'bounding_box':bounding_box,
                'center':center,
                'window_name':window_name,
                'metadata':{}
            })
            target_nodes.append(word_node)
            if current_semantic_node is not None:
                current_semantic_node.add_child(SemanticNode(
                    control_type='Word',
                    element_type='interactive',
                    name=word,
                    window_name=window_name,
                    center=center,
                    bounding_box=bounding_box,
                    metadata={},
                ))



    @staticmethod
    def _control_type_name(node:Control) -> str:
        """ControlTypeName with a Cached→Current fallback.

        Chromium's provider throws E_INVALIDARG on Cached* reads for nodes
        its BuildUpdatedCache does not support (live finding, batch 2);
        Current reads work everywhere probed."""
        try:
            return node.CachedControlTypeName
        except Exception:
            return node.CurrentControlTypeName

    def element_has_child_element(self, node:Control,control_type:str,child_control_type:str):
        # node is cached — use cached property
        if node.CachedLocalizedControlType==control_type:
            first_child=node.GetFirstChildControl()
            if first_child is None:
                return False
            # first_child from GetFirstChildControl() is NOT cached — use live access
            return first_child.LocalizedControlType==child_control_type

    def _dom_correction(self, node:Control, dom_interactive_nodes:list[TreeElementNode], window_name:str):
        if self.element_has_child_element(node,'list item','link') or self.element_has_child_element(node,'item','link') or self.element_has_child_element(node,"option","button"):
            dom_interactive_nodes.pop()
            return None
        elif self._control_type_name(node)=='GroupControl':
            dom_interactive_nodes.pop()
            # Inlined is_keyboard_focusable logic for correction
            control_type_name_check = self._control_type_name(node)
            is_kb_focusable = False
            if control_type_name_check in set(['EditControl','ButtonControl','CheckBoxControl','RadioButtonControl','TabItemControl']):
                 is_kb_focusable = True
            else:
                 is_kb_focusable = node.CachedIsKeyboardFocusable

            if is_kb_focusable:
                child=node
                try:
                    while child.GetFirstChildControl() is not None:
                        # Children from GetFirstChildControl() are NOT cached — use live access
                        if self._control_type_name(child) in INTERACTIVE_CONTROL_TYPE_NAMES:
                            return None
                        child=child.GetFirstChildControl()
                except Exception:
                    return None
                if self._control_type_name(child)!='TextControl':
                    return None
                metadata:dict[str,Any]={}
                # node is cached — use cached properties
                element_bounding_box = node.CachedBoundingRectangle
                bounding_box=self.iou_bounding_box(self.dom_bounding_box,element_bounding_box)
                center = bounding_box.get_center()
                has_focused=node.CachedHasKeyboardFocus
                accelerator_key=node.CachedAcceleratorKey
                metadata['has_focused']=has_focused
                if accelerator_key:
                    metadata['shortcut']=accelerator_key

                if isinstance(node,EditControl):
                    try:
                        value = node.GetCachedPropertyValue(PropertyId.LegacyIAccessibleValueProperty)
                        metadata['value']=value.strip() if value else '(empty)'
                    except Exception:
                        pass

                    try:
                        help_text = node.CachedHelpText
                        if help_text:
                            metadata['help_text']=help_text.encode('ascii', 'ignore').decode('ascii')
                    except Exception:
                        pass
                if child.Name.strip():
                    uia_identity, pattern_availability = self._cached_uia_contract(node)
                    dom_interactive_nodes.append(TreeElementNode(**{
                        'name':child.Name.strip(),
                        'control_type':node.CachedLocalizedControlType,
                        'bounding_box':bounding_box,
                        'center':center,
                        'window_name':window_name,
                        'metadata':metadata,
                        'uia_identity':uia_identity,
                        'pattern_availability':pattern_availability,
                    }))
        elif self.element_has_child_element(node,'link','heading'):
            dom_interactive_nodes.pop()
            # child from GetFirstChildControl() is NOT cached — use live access
            node=node.GetFirstChildControl()
            control_type='link'
            value = node.GetPropertyValue(PropertyId.LegacyIAccessibleValueProperty) or ''
            element_bounding_box = node.BoundingRectangle
            bounding_box=self.iou_bounding_box(self.dom_bounding_box,element_bounding_box)
            center = bounding_box.get_center()
            is_focused=node.HasKeyboardFocus
            metadata:dict[str,Any]={}
            metadata['has_focused']=is_focused
            if node.Name.strip():
                dom_interactive_nodes.append(TreeElementNode(**{
                    'name':node.Name.strip(),
                    'control_type':control_type,
                    'bounding_box':bounding_box,
                    'center':center,
                    'window_name':window_name,
                    'metadata':metadata
                }))
        else:
            if not node.Name.strip():
                dom_interactive_nodes.pop()


    def tree_traversal(self, node: Control, window_bounding_box:Rect, window_name:str, is_browser:bool,
                    interactive_nodes:Optional[list[TreeElementNode]]=None, scrollable_nodes:Optional[list[ScrollElementNode]]=None,
                    dom_interactive_nodes:Optional[list[TreeElementNode]]=None, dom_informative_nodes:Optional[list[TextElementNode]]=None,
                    is_dom:bool=False, is_dialog:bool=False,
                    element_cache_req:Optional[Any]=None, children_cache_req:Optional[Any]=None,
                    current_semantic_node:'Optional[SemanticNode]'=None,
                    current_reads:bool=False):
        # `current_reads` (live finding, matrix batch 2): Chromium's UIA
        # provider throws E_INVALIDARG on Cached* reads for nodes its
        # BuildUpdatedCache does not fully support, which used to fail the
        # whole browser-window crawl after 3 retries. Current* reads work on
        # every probed Chromium node, so browser windows crawl with them.
        def _n(target, cached_attr: str):
            if current_reads:
                # The Control wrapper exposes live reads unprefixed
                # (IsOffscreen / ControlTypeName / Name / …); the Current*
                # comtypes form is not wrapped.
                return getattr(target, cached_attr.replace("Cached", "", 1))
            return getattr(target, cached_attr)

        def _safe_n(target, cached_attr: str, default=None):
            try:
                return _n(target, cached_attr)
            except Exception:
                return default

        try:
            # Build cached control if caching is enabled
            if not current_reads and not hasattr(node, '_is_cached') and element_cache_req:
                node = CachedControlHelper.build_cached_control(node, element_cache_req)

            # Checks to skip the nodes that are not interactive
            is_offscreen = _n(node, 'CachedIsOffscreen')
            control_type_name = _n(node, 'CachedControlTypeName')
            # class_name = node.CachedClassName
            semantic_added = False

            # Scrollable check
            if scrollable_nodes is not None:
                if (control_type_name not in (INTERACTIVE_CONTROL_TYPE_NAMES|INFORMATIVE_CONTROL_TYPE_NAMES)) and not is_offscreen:
                    try:
                        scroll_pattern:ScrollPattern=node.GetCachedPattern(PatternId.ScrollPattern, True)
                        if scroll_pattern and scroll_pattern.VerticallyScrollable:
                            box = _n(node, 'CachedBoundingRectangle')
                            x,y=random_point_within_bounding_box(node=node,scale_factor=0.8)
                            center = Center(x=x,y=y)
                            name = _safe_n(node, 'CachedName', '') or ''
                            automation_id = _safe_n(node, 'CachedAutomationId', '')
                            localized_control_type = _safe_n(node, 'CachedLocalizedControlType', '')
                            metadata:dict[str,Any]={}
                            metadata['has_focused']=_n(node, 'CachedHasKeyboardFocus')
                            metadata['horizontal_scrollable']=scroll_pattern.HorizontallyScrollable
                            metadata['horizontal_scroll_percent']=round(scroll_pattern.HorizontalScrollPercent,2) if scroll_pattern.HorizontallyScrollable else 0
                            metadata['vertical_scrollable']=scroll_pattern.VerticallyScrollable
                            metadata['vertical_scroll_percent']=round(scroll_pattern.VerticalScrollPercent,2) if scroll_pattern.VerticallyScrollable else 0
                            uia_identity, pattern_availability = self._cached_uia_contract(node)

                            sem_scroll_name = name.strip() or automation_id or localized_control_type.capitalize() or "''"
                            self.element_budget.try_consume()
                            scrollable_nodes.append(ScrollElementNode(**{
                                'name':sem_scroll_name,
                                'control_type':localized_control_type.title(),
                                'bounding_box':BoundingBox(**{
                                    'left':box.left,
                                    'top':box.top,
                                    'right':box.right,
                                    'bottom':box.bottom,
                                    'width':box.width(),
                                    'height':box.height()
                                }),
                                'center':center,
                                'window_name':window_name,
                                'metadata':metadata,
                                'uia_identity':uia_identity,
                                'pattern_availability':pattern_availability,
                            }))
                            if current_semantic_node is not None and not is_dom:
                                current_semantic_node.add_child(SemanticNode(
                                    control_type=localized_control_type.title(),
                                    element_type='scrollable',
                                    name=sem_scroll_name,
                                    window_name=window_name,
                                    center=center,
                                    bounding_box=BoundingBox(
                                        left=box.left, top=box.top, right=box.right, bottom=box.bottom,
                                        width=box.width(), height=box.height()
                                    ),
                                    metadata=dict(metadata),
                                ))
                                semantic_added = True
                    except Exception:
                        pass

            # Interactive and Informative checks
            # Pre-calculate common properties
            is_control_element = _n(node, 'CachedIsControlElement')
            element_bounding_box = _n(node, 'CachedBoundingRectangle')
            width = element_bounding_box.width()
            height = element_bounding_box.height()
            area = width * height

            # Is Visible Check
            is_visible = (area > 0) and (not is_offscreen or control_type_name=="EditControl" or (control_type_name=="ListItemControl" and is_browser)) and is_control_element

            if is_visible:
                is_enabled = _n(node, 'CachedIsEnabled')
                if is_enabled:
                    # Determine is_keyboard_focusable
                    if control_type_name in set(['EditControl','ButtonControl','CheckBoxControl','RadioButtonControl','TabItemControl','ListItemControl']):
                        is_keyboard_focusable = True
                    else:
                        #Experimentally, ListItemControl is keyboard focusable
                        is_keyboard_focusable = _n(node, 'CachedIsKeyboardFocusable')

                    # Interactive Check
                    if interactive_nodes is not None:
                        is_interactive = False
                        if is_browser and control_type_name in set(['DataItemControl']) and not is_keyboard_focusable:
                            is_interactive = False
                        elif not is_browser and control_type_name == "ImageControl" and is_keyboard_focusable:
                            is_interactive = True
                        elif control_type_name in (INTERACTIVE_CONTROL_TYPE_NAMES|DOCUMENT_CONTROL_TYPE_NAMES):
                             # Role check
                             try:
                                role = node.GetCachedPropertyValue(PropertyId.LegacyIAccessibleRoleProperty)
                                is_role_interactive = AccessibleRoleNames.get(role, "Default") in INTERACTIVE_ROLES
                             except Exception:
                                is_role_interactive = False

                             # Image check
                             is_image = False
                             if control_type_name == 'ImageControl': # approximated
                                 localized = _safe_n(node, 'CachedLocalizedControlType', '')
                                 if localized == 'graphic' or not is_keyboard_focusable:
                                     is_image = True

                             if is_role_interactive and (not is_image or is_keyboard_focusable):
                                 is_interactive = True

                        elif control_type_name == 'GroupControl':
                             if is_browser:
                                try:
                                    has_expand_collapse = node.GetCachedPropertyValue(PropertyId.ExpandCollapseExpandCollapseStateProperty)
                                    if has_expand_collapse in ExpandCollapseState:
                                        is_interactive = True
                                except Exception:
                                    pass

                                try:
                                    role = node.GetCachedPropertyValue(PropertyId.LegacyIAccessibleRoleProperty)
                                    is_role_interactive = AccessibleRoleNames.get(role, "Default") in INTERACTIVE_ROLES
                                except Exception:
                                    is_role_interactive = False

                                is_default_action = False
                                try:
                                    default_action = node.GetCachedPropertyValue(PropertyId.LegacyIAccessibleDefaultActionProperty)
                                    if default_action and default_action.title() in DEFAULT_ACTIONS:
                                        is_default_action = True
                                except Exception:
                                    pass

                                if is_role_interactive and (is_default_action or is_keyboard_focusable):
                                    is_interactive = True

                        if isinstance(node,DocumentControl):
                            is_interactive=True

                        if is_interactive:
                            is_focused = _n(node, 'CachedHasKeyboardFocus')
                            name = (_safe_n(node, 'CachedName', '') or '').strip()
                            localized_control_type = _safe_n(node, 'CachedLocalizedControlType', '')
                            accelerator_key = _safe_n(node, 'CachedAcceleratorKey', '')

                            metadata:dict[str,Any]={}
                            metadata['has_focused']=is_focused
                            metadata['is_enabled']=True
                            uia_identity, pattern_availability = self._cached_uia_contract(node)
                            if accelerator_key:
                                metadata['shortcut']=accelerator_key

                            word_elements: list[tuple[str, Rect]] = []

                            try:
                                help_text = _safe_n(node, 'CachedHelpText', '')
                                if help_text:
                                    metadata['help_text']=help_text.encode('ascii', 'ignore').decode('ascii')
                            except Exception:
                                pass

                            if isinstance(node,(ButtonControl,CheckBoxControl)):
                                try:
                                    toggle_state = node.GetCachedPropertyValue(PropertyId.ToggleToggleStateProperty)
                                    if toggle_state is not None:
                                        match toggle_state:
                                            case ToggleState.On:
                                                metadata['toggle_state'] = 'on'
                                            case ToggleState.Off:
                                                metadata['toggle_state'] = 'off'
                                            case _:
                                                pass
                                except Exception:
                                    pass

                            if isinstance(node,(EditControl,DocumentControl,ImageControl)):
                                is_password = False
                                try:
                                    is_password = bool(_safe_n(node, 'CachedIsPassword', False))
                                    if is_password:
                                        metadata['is_password']=True
                                except Exception:
                                    pass

                                # I-07: a password control's value must not even be read —
                                # only the is_password flag travels in metadata, so the
                                # secret can never reach snapshot text, logs, or results.
                                if not is_password:
                                    try:
                                        value = node.GetCachedPropertyValue(PropertyId.LegacyIAccessibleValueProperty)
                                        metadata['value']=value.strip() if value else '(empty)'
                                        if not is_dom:
                                            words=node.GetAllWordBoundingBoxes()
                                            for word,boxes in words:
                                                for box in boxes:
                                                    word_elements.append((word,box))
                                    except Exception:
                                        pass

                                # Selection state, reported only when there is a real (non-empty)
                                # selection — a bare caret is the resting state of every focused
                                # field and would be noise on every node.
                                if not is_password:
                                    try:
                                        text_pattern = node.GetPattern(PatternId.TextPattern)
                                        if text_pattern is not None:
                                            selection = text_pattern.GetSelection()
                                            if selection:
                                                selected_range = selection[0]
                                                selected_text = selected_range.GetText()
                                                if selected_text:
                                                    metadata['selected_text'] = selected_text
                                                    document_range = text_pattern.DocumentRange
                                                    starts_at_doc_start = selected_range.CompareEndpoints(
                                                        TextPatternRangeEndpoint.Start, document_range, TextPatternRangeEndpoint.Start
                                                    ) == 0
                                                    ends_at_doc_end = selected_range.CompareEndpoints(
                                                        TextPatternRangeEndpoint.End, document_range, TextPatternRangeEndpoint.End
                                                    ) == 0
                                                    if starts_at_doc_start and ends_at_doc_end:
                                                        metadata['all_selected'] = True
                                    except Exception:
                                        pass

                            if isinstance(node,ComboBoxControl):
                                try:
                                    value = node.GetCachedPropertyValue(PropertyId.LegacyIAccessibleValueProperty)
                                    metadata['value']=value.strip() if value else '(empty)'
                                except Exception:
                                    pass

                                try:
                                    control_state=node.GetCachedPropertyValue(PropertyId.ExpandCollapseExpandCollapseStateProperty)
                                    match control_state:
                                        case ExpandCollapseState.Expanded:
                                            metadata['expand_collapse_state']='expanded'
                                        case ExpandCollapseState.Collapsed:
                                            metadata['expand_collapse_state']='collapsed'
                                        case ExpandCollapseState.PartiallyExpanded:
                                            metadata['expand_collapse_state']='partially expanded'
                                        case _:
                                            pass
                                except Exception:
                                    pass

                                try:
                                    can_select_multiple=node.GetCachedPropertyValue(PropertyId.SelectionCanSelectMultipleProperty)
                                    metadata['is_selection_required']=can_select_multiple
                                except Exception:
                                    pass

                                try:
                                    is_selection_required=node.GetCachedPropertyValue(PropertyId.SelectionIsSelectionRequiredProperty)
                                    metadata['is_selection_required']=is_selection_required
                                except Exception:
                                    pass

                                try:
                                    is_selected=node.GetCachedPropertyValue(PropertyId.SelectionItemIsSelectedProperty)
                                    metadata['is_selected']=is_selected
                                except Exception:
                                    pass

                                try:
                                    selection_raw = node.GetCachedPropertyValue(PropertyId.SelectionSelectionProperty)
                                    selected_items = Control.CreateControlsFromRawElementArray(selection_raw)
                                    selected_names = [item.Name for item in selected_items if item.Name]
                                    if selected_names:
                                        metadata['selection'] = selected_names
                                except Exception:
                                    pass

                            if isinstance(node, SliderControl):
                                try:
                                    value = node.GetCachedPropertyValue(PropertyId.RangeValueValueProperty)
                                    minimum = node.GetCachedPropertyValue(PropertyId.RangeValueMinimumProperty)
                                    maximum = node.GetCachedPropertyValue(PropertyId.RangeValueMaximumProperty)
                                    if value is not None:
                                        metadata['value'] = round(value, 2)
                                    if minimum is not None:
                                        metadata['min'] = round(minimum, 2)
                                    if maximum is not None:
                                        metadata['max'] = round(maximum, 2)
                                except Exception:
                                    pass

                            if is_browser and is_dom:
                                bounding_box=self.iou_bounding_box(self.dom_bounding_box,element_bounding_box)
                                center = bounding_box.get_center()
                                tree_node=TreeElementNode(**{
                                    'name':name,
                                    'control_type':localized_control_type.title(),
                                    'bounding_box':bounding_box,
                                    'center':center,
                                    'window_name':window_name,
                                    'metadata':metadata,
                                    'uia_identity':uia_identity,
                                    'pattern_availability':pattern_availability,
                                })
                                self.element_budget.try_consume()
                                dom_interactive_nodes.append(tree_node)
                                self._dom_correction(node, dom_interactive_nodes, window_name)
                                self._append_word_nodes(word_elements, self.dom_bounding_box, window_name, dom_interactive_nodes)
                            else:
                                bounding_box=self.iou_bounding_box(window_bounding_box,element_bounding_box)
                                center = bounding_box.get_center()
                                if name:
                                    tree_node=TreeElementNode(**{
                                        'name':name,
                                        'control_type':localized_control_type.title(),
                                        'bounding_box':bounding_box,
                                        'center':center,
                                        'window_name':window_name,
                                        'metadata':metadata,
                                        'uia_identity':uia_identity,
                                        'pattern_availability':pattern_availability,
                                    })
                                    self.element_budget.try_consume()
                                    interactive_nodes.append(tree_node)
                                    if current_semantic_node is not None:
                                        current_semantic_node.add_child(SemanticNode(
                                            control_type=tree_node.control_type,
                                            element_type='interactive',
                                            name=tree_node.name,
                                            window_name=tree_node.window_name,
                                            center=tree_node.center,
                                            bounding_box=tree_node.bounding_box,
                                            metadata=dict(tree_node.metadata),
                                        ))
                                        semantic_added = True
                                self._append_word_nodes(word_elements, window_bounding_box, window_name, interactive_nodes, current_semantic_node)

                    # Informative Check
                    if dom_informative_nodes is not None:
                         # is_element_text check
                         is_text = False
                         if control_type_name in INFORMATIVE_CONTROL_TYPE_NAMES:
                              # is_element_image check
                              is_image_check = False
                              if control_type_name == 'ImageControl':
                                   localized = _safe_n(node, 'CachedLocalizedControlType', '')

                                   if not is_keyboard_focusable:
                                        if localized == 'graphic':
                                             is_image_check = True
                                        else:
                                             is_image_check = True
                                   elif localized == 'graphic':
                                        is_image_check = True

                              if not is_image_check:
                                  is_text = True

                         if is_text:
                             if is_browser and is_dom:
                                 name = _safe_n(node, 'CachedName', '') or ''
                                 self.element_budget.try_consume()
                                 dom_informative_nodes.append(TextElementNode(
                                     text=name.strip(),
                                 ))

            # Semantic tree: promote named structural containers to tree nodes
            semantic_parent = current_semantic_node
            if (current_semantic_node is not None and not is_dom and not is_offscreen
                    and not semantic_added and control_type_name in STRUCTURAL_CONTROL_TYPE_NAMES):
                try:
                    struct_name = (_safe_n(node, 'CachedName', '') or '').strip()
                    if struct_name:
                        struct_node = SemanticNode(
                            control_type=_safe_n(node, 'CachedLocalizedControlType', '').title(),
                            element_type='structural',
                            name=struct_name,
                            window_name=window_name,
                        )
                        current_semantic_node.add_child(struct_node)
                        semantic_parent = struct_node
                except Exception:
                    pass

            # Phase 3: Cached Children Retrieval
            children = CachedControlHelper.get_cached_children(node, children_cache_req)

            # Recursively traverse the tree the right to left for normal apps and for DOM traverse from left to right
            for child in (children if is_dom else reversed(children)):
                if self.element_budget.exhausted:
                    # Stop descending once the element budget is spent — this is what
                    # bounds traversal time on huge flat lists/grids (thousands of rows),
                    # not just the size of the appended node lists. `exhausted` also
                    # covers the wall-clock budget: a slow provider (Chromium AX crawl)
                    # must not wedge this lane past every caller's deadline, so the
                    # capture degrades to an honestly-marked partial tree.
                    break
                try:
                    # Check if the child is a DOM element
                    if is_browser and _n(child, "CachedAutomationId")=="RootWebArea":
                        bounding_box=_n(child, 'CachedBoundingRectangle')
                        self.dom_bounding_box=BoundingBox(left=bounding_box.left,top=bounding_box.top,
                        right=bounding_box.right,bottom=bounding_box.bottom,width=bounding_box.width(),
                        height=bounding_box.height())
                        self.dom=child
                        # enter DOM subtree
                        self.tree_traversal(child, window_bounding_box, window_name, is_browser, interactive_nodes, scrollable_nodes, dom_interactive_nodes, dom_informative_nodes, is_dom=True, is_dialog=is_dialog, element_cache_req=element_cache_req, children_cache_req=children_cache_req, current_semantic_node=None, current_reads=current_reads)
                    # Check if the child is a dialog
                    elif isinstance(child,WindowControl):
                        if _n(child, 'CachedIsOffscreen') is False:
                            if is_dom:
                                bounding_box=_n(child, 'CachedBoundingRectangle')
                                if bounding_box.width() > 0.8*self.dom_bounding_box.width:
                                    # Because this window element covers the majority of the screen
                                    dom_interactive_nodes.clear()
                            else:
                                # Inline is_window_modal
                                is_modal = False
                                try:
                                    is_modal = child.GetCachedPropertyValue(PropertyId.WindowIsModalProperty)
                                except Exception:
                                    is_modal = False

                                if is_modal:
                                    interactive_nodes.clear()
                        # enter dialog subtree
                        self.tree_traversal(child, window_bounding_box, window_name, is_browser, interactive_nodes, scrollable_nodes, dom_interactive_nodes, dom_informative_nodes, is_dom=is_dom, is_dialog=True, element_cache_req=element_cache_req, children_cache_req=children_cache_req, current_semantic_node=semantic_parent, current_reads=current_reads)
                    else:
                        # normal non-dialog children
                        self.tree_traversal(child, window_bounding_box, window_name, is_browser, interactive_nodes, scrollable_nodes, dom_interactive_nodes, dom_informative_nodes, is_dom=is_dom, is_dialog=is_dialog, element_cache_req=element_cache_req, children_cache_req=children_cache_req, current_semantic_node=semantic_parent, current_reads=current_reads)
                except TypeError as e:
                    if not _is_comtypes_variant_ord_typeerror(e):
                        raise

                    logger.warning(
                        "Skipping UI element in '%s' due to comtypes VARIANT marshaling TypeError: %s",
                        window_name,
                        e,
                    )
                    continue
        except TypeError as e:
            if not _is_comtypes_variant_ord_typeerror(e):
                logger.error(f"Error in tree_traversal: {e}", exc_info=True)
                raise

            logger.warning(
                "Skipping subtree in '%s' due to comtypes VARIANT marshaling TypeError: %s",
                window_name,
                e,
            )
        except Exception as e:
            if is_uia_dead_element_error(e):
                logger.debug("Skipping dead UIA subtree in '%s': %s", window_name, e)
                return
            logger.error(f"Error in tree_traversal: {e}", exc_info=True)
            raise

    def app_name_correction(self,window_name:str)->str:
        match window_name:
            case "Progman":
                return "Desktop"
            case 'Shell_TrayWnd'|'Shell_SecondaryTrayWnd':
                return "Taskbar"
            case 'Microsoft.UI.Content.PopupWindowSiteBridge':
                return "Context Menu"
            case _:
                return window_name

    def _ia2_dom_walk(self, handle: int, window_name: str, window_bounding_box,
                      dom_interactive_nodes: list, dom_informative_nodes: list) -> bool:
        """One bounded IA2 (MSAA) walk filling the DOM node lists.

        Returns True when the walk produced web content. The walk gets a
        guaranteed wall-clock slice (at least IA2_MIN_TIME_BUDGET_SECONDS)
        instead of whatever crumbs remain from the UIA crawl — a browser
        whose DOM is only reachable here must not starve behind other
        windows' crawl time.
        """
        try:
            window_box = BoundingBox(
                left=window_bounding_box.left,
                top=window_bounding_box.top,
                right=window_bounding_box.right,
                bottom=window_bounding_box.bottom,
                width=window_bounding_box.width(),
                height=window_bounding_box.height(),
            )
            remaining = self.element_budget.time_remaining_seconds
            budget = (
                max(IA2_MIN_TIME_BUDGET_SECONDS, remaining)
                if remaining is not None
                else None
            )
            ia2_t0 = perf_counter()
            ia2_result = ia2_traversal.traverse_window(
                hwnd=handle,
                window_name=window_name,
                window_bounding_box=window_box,
                time_budget_seconds=budget,
            )
            ia2_ms = (perf_counter() - ia2_t0) * 1000
            if not ia2_result:
                return False
            # traverse_window() already walked the whole IAccessible tree before
            # returning, so this can't bound traversal time — but it still caps
            # how much of the result gets appended/serialized.
            cap = self.element_budget.remaining
            capped_interactive = ia2_result.interactive_nodes[:cap]
            remaining_after_interactive = max(0, cap - len(capped_interactive))
            capped_informative = ia2_result.informative_nodes[:remaining_after_interactive]
            if (
                len(capped_interactive) < len(ia2_result.interactive_nodes)
                or len(capped_informative) < len(ia2_result.informative_nodes)
            ):
                self.element_budget.truncated = True
            self.element_budget.try_consume(len(capped_interactive) + len(capped_informative))
            dom_interactive_nodes.extend(capped_interactive)
            dom_informative_nodes.extend(capped_informative)
            # Pin the bbox to the FIRST browser window walked (the active
            # one — it's first in windows_handles). Subsequent windows
            # contribute nodes but mustn't clobber the active window's bbox.
            if not self.dom_is_ia2:
                self.dom_bounding_box = ia2_result.dom_bounding_box or window_box
                self.dom_is_ia2 = True
            if ia2_result.time_truncated:
                # The IA2 walk hit its wall-clock budget; surface the
                # same honest-degradation signal as the UIA budget.
                self.element_budget.time_truncated = True
            logger.info(
                "IA2 walk for '%s' produced %d interactive / %d informative nodes in %.1fms",
                window_name,
                len(ia2_result.interactive_nodes),
                len(ia2_result.informative_nodes),
                ia2_ms,
            )
            return bool(capped_interactive or capped_informative)
        except Exception as e:
            logger.warning("IA2 walk failed for '%s' (handle %#x): %s", window_name, handle, e)
            return False

    def get_nodes(self, handle: int, is_browser:bool=False, wait_time:float=0, use_dom:bool=False) -> tuple[list[TreeElementNode],list[ScrollElementNode],list[TextElementNode],Optional[SemanticNode]]:
        if wait_time > 0:
            sleep(wait_time)
        try:
            node = ControlFromHandle(handle)
            if not node:
                 raise RuntimeError(f"Failed to create Control from window handle {handle:#x}")

            window_bounding_box=node.BoundingRectangle

            interactive_nodes, dom_interactive_nodes, dom_informative_nodes, scrollable_nodes = [], [], [], []
            window_name=node.Name.strip()
            window_name=self.app_name_correction(window_name)

            if use_dom and not is_browser:
                # use_dom asks for browser web content; a native window's UIA
                # crawl is discarded wholesale in this mode (get_window_wise_nodes
                # only consumes the DOM lists), so crawling it is pure latency —
                # skip. Non-use_dom callers keep the full crawl below.
                return ([], [], [], None)

            if is_browser and use_dom and self.dom is None and not self.dom_is_ia2:
                # DOM-first for browser windows (live probe, matrix batch 2):
                # current Chromium builds expose web content only through the
                # MSAA/IA2 walk (~1s, bounded), while the UIA crawl of a
                # forced-AX Chromium tree is the slow path that used to eat
                # the whole capture budget BEFORE the IA2 fallback ever ran.
                # The UIA crawl below stays as the fallback for engines where
                # IA2 yields nothing but UIA exposes a RootWebArea document.
                ia2_hit = self._ia2_dom_walk(
                    handle, window_name, window_bounding_box,
                    dom_interactive_nodes, dom_informative_nodes,
                )
                if ia2_hit:
                    return (dom_interactive_nodes, [], dom_informative_nodes, None)

            # Create fresh cache requests for this traversal session
            element_cache_req = CacheRequestFactory.create_tree_traversal_cache()
            element_cache_req.TreeScope = TreeScope.TreeScope_Element

            children_cache_req = CacheRequestFactory.create_tree_traversal_cache()
            children_cache_req.TreeScope = TreeScope.TreeScope_Element | TreeScope.TreeScope_Children

            window_sem_node: Optional[SemanticNode] = None
            if not is_browser:
                window_sem_node = SemanticNode(
                    control_type='Window',
                    element_type='window',
                    name=window_name,
                    window_name=window_name,
                )

            self.tree_traversal(node, window_bounding_box, window_name, is_browser, interactive_nodes, scrollable_nodes, dom_interactive_nodes, dom_informative_nodes, is_dom=False, is_dialog=False, element_cache_req=element_cache_req, children_cache_req=children_cache_req, current_semantic_node=window_sem_node, current_reads=is_browser)

            # IA2 fallback (post-crawl): kept for ordering parity with the
            # legacy path — browsers whose UIA tree yielded no RootWebArea and
            # whose DOM-first walk above didn't run (use_dom=False callers)
            # still get the IA2 walk when DOM content is requested.
            if is_browser and use_dom and self.dom is None and not self.dom_is_ia2:
                self._ia2_dom_walk(
                    handle, window_name, window_bounding_box,
                    dom_interactive_nodes, dom_informative_nodes,
                )

            logger.debug(f'Window name:{window_name}')
            logger.debug(f'Interactive nodes:{len(interactive_nodes)}')
            if is_browser:
                logger.debug(f'DOM interactive nodes:{len(dom_interactive_nodes)}')
                logger.debug(f'DOM informative nodes:{len(dom_informative_nodes)}')
            logger.debug(f'Scrollable nodes:{len(scrollable_nodes)}')

            if not is_browser and window_sem_node is not None:
                # tree_traversal visits reversed(children) for native apps — fix ordering now
                _reverse_children_order(window_sem_node)
            elif is_browser:
                # Build the browser window semantic tree post-hoc from the flat
                # lists that will actually be returned: DOM content when the web
                # area was reachable (UIA RootWebArea or the IA2/MSAA walk), or
                # the browser chrome when it was not — a window that returns
                # nothing is invisible to the caller.
                dom_hit = bool(dom_interactive_nodes or dom_informative_nodes)
                sem_interactive = dom_interactive_nodes if dom_hit else interactive_nodes
                sem_informative = dom_informative_nodes if dom_hit else []
                window_sem_node = SemanticNode(
                    control_type='Window',
                    element_type='window',
                    name=window_name,
                    window_name=window_name,
                )
                for n in sem_interactive:
                    window_sem_node.add_child(SemanticNode(
                        control_type=n.control_type,
                        element_type='interactive',
                        name=n.name,
                        window_name=n.window_name,
                        center=n.center,
                        bounding_box=n.bounding_box,
                        metadata=dict(n.metadata),
                    ))
                for text_node in sem_informative:
                    if text_node.text:
                        window_sem_node.add_child(SemanticNode(
                            control_type='Text',
                            element_type='informative',
                            name=text_node.text,
                            window_name=window_name,
                        ))

            if use_dom:
                if is_browser:
                    if dom_interactive_nodes or dom_informative_nodes:
                        return (dom_interactive_nodes, scrollable_nodes, dom_informative_nodes, window_sem_node)
                    # Honest degradation (live probe, matrix batch 2): a browser
                    # whose renderer AX tree was never built — e.g. --new-window
                    # into an already-running Chrome without accessibility —
                    # exposes neither UIA web content nor an IA2 DOM. Returning
                    # empty lists would make the whole window vanish from the
                    # snapshot; falling back to the browser chrome keeps the
                    # window visible and actionable at UIA-chrome fidelity.
                    logger.warning(
                        "[Tree] Browser '%s' exposed no web content (renderer "
                        "accessibility is likely off for the running browser "
                        "process) — falling back to browser chrome elements",
                        window_name,
                    )
                    return (interactive_nodes, scrollable_nodes, [], window_sem_node)
                else:
                    return ([], [], [], None)
            else:
                interactive_nodes.extend(dom_interactive_nodes)
                return (interactive_nodes, scrollable_nodes, dom_informative_nodes, window_sem_node)
        except COMError as e:
            uia_exc = from_com_error(e)
            if isinstance(uia_exc, UIADeadElementError):
                logger.debug(f"Window {handle:#x} is no longer accessible (dead element)")
            else:
                logger.error(f"UIA error for handle {handle:#x}: {uia_exc}")
            raise uia_exc from e
        except Exception as e:
            logger.error(f"Error getting nodes for handle {handle}: {e}")
            raise

    def on_focus_change(self, sender: Any):
        """Handle focus change events."""
        # Debounce duplicate events
        current_time = perf_counter()
        element = Control.CreateControlFromElement(sender)
        runtime_id=element.GetRuntimeId()
        event_key = tuple(runtime_id)
        if hasattr(self, '_last_focus_event') and self._last_focus_event:
            last_key, last_time = self._last_focus_event
            if last_key == event_key and (current_time - last_time) < 1.0:
                return None
        self._last_focus_event = (event_key, current_time)

        try:
            logger.debug(f"[WatchDog] Focus changed to: '{element.Name}' ({element.ControlTypeName})")
        except Exception:
            pass
