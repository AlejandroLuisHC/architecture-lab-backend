import { z } from 'zod';
import type { LabConfiguration } from './lab.js';

export const simulatedResourceStatesSchema = z
    .record(
        z.string().min(1).max(80),
        z.enum(['running', 'stopped', 'enabled', 'disabled', 'logging', 'logging-stopped']),
    )
    .default({});
export type SimulatedResourceStates = z.infer<typeof simulatedResourceStatesSchema>;

function allowedStates(service: string): string[] {
    if (service === 'ec2' || service === 'aurora') return ['running', 'stopped'];
    if (service === 'cloudfront' || service === 'cloudFrontDistribution') return ['enabled', 'disabled'];
    if (service === 'cloudTrail') return ['logging', 'logging-stopped'];
    return [];
}

export function validateSimulatedStates(
    configuration: LabConfiguration,
    states: SimulatedResourceStates,
): void {
    const resources = new Map(configuration.resources.map((resource) => [resource.id, resource]));
    for (const [id, state] of Object.entries(states)) {
        const resource = resources.get(id);
        if (!resource) throw new Error(`Simulated state refers to missing resource ${id}.`);
        const service = resource.type === 'awsResource' ? resource.service : resource.type;
        if (!allowedStates(service).includes(state)) {
            throw new Error(`Simulated state ${state} is unavailable for resource ${id}.`);
        }
    }
}
