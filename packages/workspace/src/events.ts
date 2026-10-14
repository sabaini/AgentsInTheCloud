import type { JsonObject } from "@agents-in-the-cloud/core";
import type { WorkspaceCreationContext, WorkspaceDockerPlan, WorkspaceInitInstruction } from "./types.ts";

export interface WorkspaceCreatedEvent {
  workspaceId: string;
  init?: WorkspaceInitInstruction;
  context?: WorkspaceCreationContext;
}

export interface WorkspaceDeletedEvent {
  workspaceId: string;
}

export interface WorkspaceDeleteInspectEvent {
  workspaceId: string;
  issues: JsonObject[];
}

export interface WorkspaceUserActivityEvent {
  workspaceId: string;
}

export interface WorkspaceTitleChangedEvent {
  workspaceId: string;
  title: string;
}

export interface WorkspaceAgentTurnFinishedEvent {
  workspaceId: string;
  agentId: string;
}

export interface WorkspaceAgentTitleChangedEvent {
  workspaceId: string;
  agentId: string;
  title: string;
}

export interface WorkspaceAgentViewInvalidatedEvent {
  workspaceId: string;
  agentId: string;
}

export interface WorkspaceSourcePrepareEvent {
  workspaceId: string;
  init?: WorkspaceInitInstruction;
  context?: WorkspaceCreationContext;
  workHostPath: string;
  workContainerPath: string;
}

export interface WorkspacePlanPrepareEvent extends WorkspaceSourcePrepareEvent {
  plan: WorkspaceDockerPlan;
}

export interface WorkspaceImageConfigureEvent {
  init?: WorkspaceInitInstruction;
  dockerfile?: string;
}

declare module "@agents-in-the-cloud/core" {
  interface AgentsInTheCloudEventMap {
    agent_type_default_changed: { agentTypeId: string };
    workspace_image_configure: WorkspaceImageConfigureEvent;
    workspace_source_prepare: WorkspaceSourcePrepareEvent;
    workspace_plan_prepare: WorkspacePlanPrepareEvent;
    workspace_created: WorkspaceCreatedEvent;
    workspace_suspending: { workspaceId: string };
    workspace_runtime_ready: { workspaceId: string };
    workspace_deleting: WorkspaceDeletedEvent;
    workspace_deleted: WorkspaceDeletedEvent;
    /** A deletion that emitted workspace_deleting stopped before the workspace was gone; it carries on. */
    workspace_delete_failed: WorkspaceDeletedEvent;
    workspace_delete_inspect: WorkspaceDeleteInspectEvent;
    workspace_user_activity: WorkspaceUserActivityEvent;
    workspace_title_changed: WorkspaceTitleChangedEvent;
    workspace_agent_turn_finished: WorkspaceAgentTurnFinishedEvent;
    workspace_agent_title_changed: WorkspaceAgentTitleChangedEvent;
    workspace_agent_view_invalidated: WorkspaceAgentViewInvalidatedEvent;
  }
}
