// Matterbridge plugin for AEG RX9 / Electrolux Pure i9 robot vacuum
// Copyright © 2025 Alexander Thoukydides

import { AnsiLogger } from 'matterbridge/logger';
import { Config } from './config-types.js';
import { EndpointRX9 } from './endpoint-rx9.js';
import {
    RvcCleanModeRX9,
    RvcOperationalStateRX9,
    RvcRunModeRX9
} from './behavior-rx9.js';
import { AEGApplianceRX9 } from './aeg-appliance-rx9.js';
import { BabelRX9 } from './babel-rx9.js';
import {
    OperationalState,
    PowerSource,
    RvcCleanMode,
    RvcOperationalState,
    RvcRunMode,
    ServiceArea
} from 'matterbridge/matter/clusters';
import {
    ChangeToModeError,
    RvcOperationalStateError
} from './error-rx9.js';
import { isDeepStrictEqual } from 'util';
import { formatSeconds, MS } from './utils.js';
import { ActivityRX9 } from './aeg-appliance-rx9-ctrl-activity.js';
import { AN, AV, CN, CV, RR } from './logger-options.js';
import {
    BasicInformationServer,
    BridgedDeviceBasicInformationServer
} from 'matterbridge/matter/behaviors';

// A Matterbridge robot vacuum cleaner device
export class DeviceRX9 extends EndpointRX9 {

    // Translation from Electrolux Global API to Matter attributes
    babel:      BabelRX9;

    // State for determining whether to trigger an event
    private lastIsActive = false;
    private startActive = 0;
    private lastOperationalError = RvcOperationalStateError.toStruct();
    private readonly attributeFingerprints = new Map<string, string>();

    // Construct a new endpoint
    constructor(
        readonly log:       AnsiLogger,
        readonly config:    Config,
        readonly appliance: AEGApplianceRX9
    ) {
        // Create a robot vacuum cleaner device
        const babel = new BabelRX9(log, config, appliance);
        super(log, config, babel.static);
        this.babel = babel;

        // Update the cluster attributes and trigger events when required
        this.updateBasicInformation();
        this.updatePowerSource();
        this.updateRvcRunMode();
        this.updateRvcCleanMode();
        this.updateRvcOperationalState();
        if (babel.static.supportedAreas.length) {
            this.updateServiceAreaCluster();
        }

        // Identify the device
        this.addCommandHandler('identify', () => {
            this.log.info(`${CN}Identify device${RR}`);
        });

        // Handle RVC Operational State Pause/Resume/GoHome commands
        this.setCommandHandlerRX9('Pause', async () => {
            const activity: ActivityRX9 = 'Pause';
            this.log.info(`${CN}RVC Operational State ${CV}Pause${RR} → ${CV}${activity}${RR}`);
            const allowed = await this.appliance.setActivity(activity);
            if (!allowed) throw new RvcOperationalStateError.CommandInvalidInState();
        });
        this.setCommandHandlerRX9('Resume', async () => {
            const activity: ActivityRX9 = 'Resume';
            this.log.info(`${CN}RVC Operational State ${CV}Resume${RR} → ${CV}${activity}${RR}`);
            const allowed = await this.appliance.setActivity(activity);
            if (!allowed) throw new RvcOperationalStateError.CommandInvalidInState();
        });
        this.setCommandHandlerRX9('GoHome', async () => {
            const activity: ActivityRX9 = 'Home';
            this.log.info(`${CN}RVC Operational State ${CV}GoHome${RR} → ${CV}${activity}${RR}`);
            const allowed = await this.appliance.setActivity(activity);
            if (!allowed) throw new RvcOperationalStateError.CommandInvalidInState();
        });

        // Handle RVC Run Mode cluster ChangeToMode commands
        this.setCommandHandlerRX9('ChangeRunMode', async newMode => {
            const activityMap: Record<RvcRunModeRX9, ActivityRX9> = {
                [RvcRunModeRX9.Idle]:       'Stop',
                [RvcRunModeRX9.Cleaning]:   'Clean'
            };
            const activity = activityMap[newMode];
            this.log.info(`${CN}RVC Run Mode${RR} ChangeToMode ${CV}${RvcRunModeRX9[newMode]}${RR}`
                        + ` (${CV}${newMode}${RR}) → ${CV}${activity}${RR}`);
            const allowed = await this.appliance.setActivity(activity);
            if (!allowed) throw new ChangeToModeError.InvalidInMode();
        });

        // Reject all RVC Clean Mode cluster ChangeToMode commands
        this.setCommandHandlerRX9('ChangeCleanMode', newMode => {
            // API does not support changing power mode or selecting spot cleaning
            this.log.info(`${CN}RVC Clean Mode${RR} ChangeToMode ${CV}${RvcCleanModeRX9[newMode]}${RR}`
                + ` (${CV}${newMode}${RR}) → ${CV}not supported${RR}`);
            throw new Error('Unsupported by Electrolux Global API');
        });

        // Handle Service Area SelectAreas commands
        this.setCommandHandlerRX9('SelectAreas', newAreas => {
            this.babel.areas.selectedAreas = newAreas;
            this.log.info(`${CN}ServiceArea${RR} SelectAreas ${CV}${this.babel.areas.toString()}${RR}`);
        });
    }

    // Start polling the device and set the initial state
    async start(): Promise<void> {
        await this.appliance.start();
    }

    // Stop polling the device
    async stop(): Promise<void> {
        await this.appliance.stop();
    }

    // Update the (Bridged Device) Basic Information cluster attributes when required
    updateBasicInformation(): void {
        this.babel.on('reachable', async reachable => {
            this.log.info(`${AN}Reachable${RR}: ${AV}${reachable}${RR}`);
            if (this.serverNode) await this.serverNode.setStateOf(BasicInformationServer,   { reachable });
            else                 await this.setStateOf(BridgedDeviceBasicInformationServer, { reachable });
        }).on('softwareVersion', async version => {
            this.log.info(`${AN}Software version${RR}: ${AV}${version}${RR}`);
            const state = { softwareVersion: parseInt(version, 10), softwareVersionString: version };
            if (this.serverNode) await this.serverNode.setStateOf(BasicInformationServer,   state);
            else                 await this.setStateOf(BridgedDeviceBasicInformationServer, state);
        });
    }

    // Update the Power Source cluster attributes when required
    updatePowerSource(): void {
        this.babel.on('batteryStatus', async ({ status, batPercentRemaining, batChargeLevel, batChargeState }) => {
            const clusterId = PowerSource.Cluster.id;
            const logMessage = `${AN}Battery status${RR}: ${AV}${batPercentRemaining / 2}${RR}%`
                             + ` ${AV}${PowerSource.BatChargeLevel[batChargeLevel]}${RR} (${AV}${batChargeLevel}${RR}),`
                             + ` ${AV}${PowerSource.PowerSourceStatus[status]}${RR} (${AV}${status}${RR}),`
                             + ` ${AV}${PowerSource.BatChargeState[batChargeState]}${RR} (${AV}${batChargeState}${RR})`;
            this.log.info(logMessage);
            await Promise.all([
                this.updateAttributeIfChanged(clusterId, 'status',              status),
                this.updateAttributeIfChanged(clusterId, 'batPercentRemaining', batPercentRemaining),
                this.updateAttributeIfChanged(clusterId, 'batChargeLevel',      batChargeLevel),
                this.updateAttributeIfChanged(clusterId, 'batChargeState',      batChargeState)
            ]);
        });
    }

    // Update the RVC Run Mode cluster attributes when required
    updateRvcRunMode(): void {
        this.babel.on('runMode', async runMode => {
            const clusterId = RvcRunMode.Cluster.id;
            this.log.info(`${AN}RVC Run Mode${RR}: ${AV}${RvcRunModeRX9[runMode]}${RR} (${AV}${runMode}${RR})`);
            await this.updateAttributeIfChanged(clusterId, 'currentMode', runMode);
        });
    }

    // Update the RVC Clean Mode cluster attributes when required
    updateRvcCleanMode(): void {
        this.babel.on('cleanMode', async cleanMode => {
            const clusterId = RvcCleanMode.Cluster.id;
            this.log.info(`${AN}RVC Clean Mode${RR}: ${AV}${RvcCleanModeRX9[cleanMode]}${RR} (${AV}${cleanMode}${RR})`);
            await this.updateAttributeIfChanged(clusterId, 'currentMode', cleanMode);
        });
    }

    // Update the RVC Operational State cluster attributes when required
    updateRvcOperationalState(): void {
        this.babel.on('operationalState', async ({ operationalState, operationalError, isActive }) => {
            const clusterId = RvcOperationalState.Cluster.id;
            this.log.info(`${AN}RVC Operational State${RR}: ${AV}${RvcOperationalStateRX9[operationalState]}${RR}`
                        + ` (${AV}${operationalState}${RR})`);
            await Promise.all([
                this.updateAttributeIfChanged(clusterId, 'operationalState', operationalState),
                this.updateAttributeIfChanged(clusterId, 'operationalError', operationalError)
            ]);

            // Trigger OperationCompletion event when changing from active to idle
            const { errorStateId, errorStateLabel, errorStateDetails } = operationalError;
            const isError = errorStateId !== RvcOperationalState.ErrorState.NoError;
            if (this.lastIsActive !== isActive) {
                this.lastIsActive = isActive;
                if (isActive) {
                    this.log.info(`(${AN}RVC Operation Started${RR})`);
                    this.startActive = Date.now();
                } else {
                    const totalOperationalTime = Math.round((Date.now() - this.startActive) / MS);
                    this.log.info(`${AN}RVC Operation Completion${RR} in ${AV}${formatSeconds(totalOperationalTime)}${RR}`);
                    const payload: OperationalState.OperationCompletionEvent = {
                        completionErrorCode:    errorStateId,
                        totalOperationalTime
                    };
                    await this.triggerEvent(clusterId, 'operationCompletion', payload, this.log);
                }
            }

            // Trigger OperationalError event if there is a new error
            if (!isDeepStrictEqual(this.lastOperationalError, operationalError)) {
                this.lastOperationalError = operationalError;
                if (isError) {
                    const errorName = RvcOperationalState.ErrorState[errorStateId];
                    let logMessage = `${AN}RVC Operational Error${RR}:`
                                   + ` ${errorName ? `${AV}${errorName}${RR} (${AV}${errorStateId}${RR})` : `${AV}${errorStateId}${RR}`}`;
                    if (errorStateLabel)   logMessage += ` [${AV}${errorStateLabel}${RR}]`;
                    if (errorStateDetails) logMessage += `: ${AV}${errorStateDetails}${RR}`;
                    this.log.info(logMessage);
                    const payload: RvcOperationalState.OperationalErrorEvent = {
                        errorState: operationalError
                    };
                    await this.triggerEvent(clusterId, 'operationalError', payload, this.log);
                } else {
                    this.log.info(`${AN}RVC Operational Error${RR}: ${AV}Error cleared${RR}`);
                }
            }
        });
    }

    // Update the Service Area cluster attributes when required
    updateServiceAreaCluster(): void {
        this.babel.on('serviceArea', async ({ currentArea, progress }) => {
            const areaName = (areaId: number | null): string => {
                if (areaId === null) return 'None';
                const area = this.information.supportedAreas.find(area => area.areaId === areaId);
                return area?.areaInfo.locationInfo?.locationName ?? `Unknown ${areaId}`;
            };
            const clusterId = ServiceArea.Cluster.id;
            const progressStatus = progress.map(({ areaId, status }) =>
                `${AV}${areaName(areaId)}${RR}: ${AV}${ServiceArea.OperationalStatus[status]}${RR} (${AV}${status}${RR})`);
            this.log.info(`${AN}Service Area${RR}: ${AV}${areaName(currentArea)}${RR} [${progressStatus.join(', ')}]`);
            await Promise.all([
                this.updateAttributeIfChanged(clusterId, 'currentArea', currentArea),
                this.updateAttributeIfChanged(clusterId, 'progress',    progress)
            ]);
        });
    }

    // Skip redundant writes to reduce endpoint transaction pressure.
    private async updateAttributeIfChanged(
        clusterId: Parameters<EndpointRX9['updateAttribute']>[0],
        attribute: string,
        value: Parameters<EndpointRX9['updateAttribute']>[2]
    ): Promise<void> {
        const key = `${this.normalizeClusterId(clusterId)}:${attribute}`;
        const nextFingerprint = this.fingerprintValue(value);
        if (this.attributeFingerprints.get(key) === nextFingerprint) return;
        await this.updateAttribute(clusterId, attribute, value, this.log);
        this.attributeFingerprints.set(key, nextFingerprint);
    }

    private fingerprintValue(value: unknown): string {
        if (value === null) return 'null';
        switch (typeof value) {
        case 'undefined': return 'undefined';
        case 'number':    return Number.isNaN(value) ? 'number:NaN' : `number:${value}`;
        case 'boolean':   return `boolean:${value}`;
        case 'string':    return `string:${value}`;
        case 'symbol':    return `symbol:${value.description ?? ''}`;
        case 'function':  return 'function';
        case 'object':
            try {
                return `json:${JSON.stringify(value)}`;
            } catch {
                return `object:${Object.prototype.toString.call(value)}`;
            }
        default:
            return 'unknown';
        }
    }

    private normalizeClusterId(clusterId: Parameters<EndpointRX9['updateAttribute']>[0]): string {
        switch (typeof clusterId) {
        case 'string':
        case 'number':
        case 'bigint':
        case 'boolean':
            return String(clusterId);
        case 'object':
            if ('id' in clusterId) {
                const id = (clusterId as { id?: unknown }).id;
                if (typeof id === 'number') return `id:${id}`;
            }
            if ('name' in clusterId) {
                const name = (clusterId as { name?: unknown }).name;
                if (typeof name === 'string') return `name:${name}`;
            }
            return `object:${Object.prototype.toString.call(clusterId)}`;
        default:
            return typeof clusterId;
        }
    }
}
