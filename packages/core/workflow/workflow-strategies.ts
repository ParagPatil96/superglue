import type { ExecutionStep, Metadata, RequestOptions, WorkflowStepResult } from "@superglue/shared";
import { applyJsonata } from "../utils/tools.js";
import { logMessage } from "../utils/logs.js";
import { executeApiCall } from "../graphql/resolvers/call.js";

export interface ExecutionStrategy {
  execute(
    step: ExecutionStep,
    payload: Record<string, any>,
    credentials: Record<string, string>,
    options: RequestOptions,
    metadata: Metadata
  ): Promise<WorkflowStepResult>;
}

export function selectStrategy(step: ExecutionStep): ExecutionStrategy {
  const strategy = step.executionMode == "LOOP" ? loopStrategy : directStrategy;
  return strategy;
}

// ======= Strategy implementations =======

const directStrategy: ExecutionStrategy = {
  async execute(
    step: ExecutionStep,
    payload: Record<string, any>,
    credentials: Record<string, string>,
    options: RequestOptions = {},
    metadata: Metadata
  ): Promise<WorkflowStepResult> {
    const result: WorkflowStepResult = {
      stepId: step.id,
      success: false
    }
    try {
      const apiResponse = await executeApiCall(step.apiConfig, payload, credentials, options, metadata);
      const transformedData = await applyJsonata(apiResponse.data, step.responseMapping);

      result.rawData = apiResponse.data;
      result.transformedData = transformedData;
      result.success = true;

      logMessage("info", `Direct Execution '${step.id}' - Complete`, metadata);
    } catch (error) {
      const errorMessage = `Error in direct execution for step ${step.id}: ${error}`;

      result.error = errorMessage;
      result.success = false;
      logMessage("error", errorMessage, metadata);
    }
    return result;
  },
};

const loopStrategy: ExecutionStrategy = {
  async execute(
    step: ExecutionStep,
    payload: Record<string, any>,
    credentials: Record<string, string>,
    options: RequestOptions = {},
    metadata: Metadata
  ): Promise<WorkflowStepResult> {
    const result: WorkflowStepResult = {
      stepId: step.id,
      success: false
    }

    try {
      if (!step.loopSelector) {
        if(Array.isArray(payload)) {
          step.loopSelector = "$";
        }
        else {
          throw new Error("loopSelector is required for LOOP execution mode");
        }
      }
      
      let loopValues: any[] = await applyJsonata(payload, step.loopSelector);
      if (!Array.isArray(loopValues) || loopValues.length === 0) {
        throw `[LOOP] No values found for loop variable '${step.loopSelector}'`;
      }

      if (step.loopMaxIters > 0) {
        loopValues = loopValues.slice(0, step.loopMaxIters);
      }
      const stepResults: WorkflowStepResult[] = [];
      for (let i = 0; i < loopValues.length; i++) {
        const loopValue = loopValues[i];
        logMessage("debug", `[LOOP] Executing for ${loopValue} (${i + 1}/${loopValues.length})`, metadata);

        const loopPayload = {
          ...payload,
          value: loopValue,
        };

        try {
          const apiResponse = await executeApiCall(step.apiConfig, loopPayload, credentials, options, metadata);
          const rawData = {loopValue: loopValue, ... apiResponse.data};
          const transformedData = await applyJsonata(rawData, step.responseMapping);
          stepResults.push({ 
            stepId: step.id, 
            success: true, 
            rawData: rawData, 
            transformedData: transformedData 
          });
        } catch (callError) {
          const errorMessage = `[LOOP] Error processing '${loopValue}': ${String(callError)}`;
          logMessage("error", errorMessage, metadata);
          throw errorMessage;
        }
      }
      result.rawData = stepResults.map(r => r.rawData);
      result.transformedData = stepResults.map(r => r.transformedData);
      result.success = stepResults.every(r => r.success);
      result.error = stepResults.filter(s => s.error).join("\n");
    } catch (error) {
      result.success = false;
      result.error = error.message || error;
    }
    logMessage("info", `[LOOP] Execution '${step.id}' - Complete`, metadata);
    return result;
  }
};