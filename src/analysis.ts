import { z } from 'zod';
import { configurationSchema } from './lab.js';
import { estimateMonthlyCost } from './pricing.js';
import { collectArchitectureFindings } from './analysis/rules.js';
import { relationshipSchema } from './scenario.js';
import { simulatedResourceStatesSchema } from './lifecycle.js';

export const workloadSchema = z.object({
    requestsPerMonth: z.number().finite().min(0).max(1_000_000_000_000),
    averageDurationMs: z.number().finite().min(0).max(900_000),
    storageGb: z.number().finite().min(0).max(10_000_000),
    availabilityTarget: z.number().finite().min(90).max(99.999),
});

export const analysisRequestSchema = z.object({
    configuration: configurationSchema,
    simulatedResourceStates: simulatedResourceStatesSchema.optional(),
    region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
    workloadAssumptions: workloadSchema,
    relationships: z.array(relationshipSchema).max(160).optional(),
    cloudFormationSource: z.string().max(1_048_576).optional(),
    refreshPrices: z.boolean().optional(),
    scenarioId: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
});

export type AnalysisInput = z.infer<typeof analysisRequestSchema>;

export async function analyzeArchitecture(input: AnalysisInput) {
    const stoppedIds = Object.entries(input.simulatedResourceStates ?? {})
        .filter(([, state]) => ['stopped', 'disabled', 'logging-stopped'].includes(state))
        .map(([id]) => id);
    const findings = [
        ...collectArchitectureFindings(input),
        ...stoppedIds.map((id) => ({
            id: `simulated-state-${id}`,
            category: 'reliability' as const,
            severity: 'warning' as const,
            title: 'Resource is inactive in the simulation',
            explanation: `${id} is inactive. Connected services may not deliver the expected workload.`,
            recommendation:
                'Review its dependencies and activate it before modeling an available architecture.',
            resourceIds: [id],
        })),
    ];
    const cost = await estimateMonthlyCost(
        input.configuration,
        input.region,
        input.workloadAssumptions,
        input.refreshPrices,
    );
    const { catalog, ...estimate } = cost;

    return {
        findings,
        estimate: {
            ...estimate,
            assumptions: [
                ...estimate.assumptions,
                'Simulated start, stop, enable, and logging states do not adjust this price estimate.',
            ],
        },
        performance: {
            summary: `Rule-based estimate for ${input.workloadAssumptions.requestsPerMonth.toLocaleString()} requests per month in ${input.region}; no cloud workload was run.`,
            assumptions: [
                `${input.workloadAssumptions.averageDurationMs} ms average request duration`,
                `${input.workloadAssumptions.availabilityTarget}% availability target`,
                'Latency, throughput, and failure rates require a real workload test to measure.',
                'Inactive simulated resources may interrupt traffic; this estimate does not model exact capacity changes.',
            ],
        },
        catalog,
    };
}
