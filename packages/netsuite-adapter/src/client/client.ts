/*
*                      Copyright 2023 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

import { AccountId, Change, getChangeData, InstanceElement, isInstanceChange, isModificationChange, CredentialError, isInstanceElement, isField, ChangeDataType, isAdditionChange, isAdditionOrModificationChange, ObjectType, isObjectTypeChange, isFieldChange } from '@salto-io/adapter-api'
import { logger } from '@salto-io/logging'
import { decorators, collections, values } from '@salto-io/lowerdash'
import { elements as elementUtils } from '@salto-io/adapter-components'
import _ from 'lodash'
import { captureServiceIdInfo } from '../service_id_info'
import { NetsuiteQuery } from '../query'
import { Credentials, isSuiteAppCredentials, toUrlAccountId } from './credentials'
import SdfClient from './sdf_client'
import SuiteAppClient from './suiteapp_client/suiteapp_client'
import { createSuiteAppFileCabinetOperations, SuiteAppFileCabinetOperations, DeployType } from '../suiteapp_file_cabinet'
import { ConfigRecord, SavedSearchQuery, SystemInformation } from './suiteapp_client/types'
import { CustomRecordTypeRecords, RecordValue } from './suiteapp_client/soap_client/types'
import { AdditionalDependencies, CustomizationInfo, GetCustomObjectsResult, getOrTransformCustomRecordTypeToInstance, ImportFileCabinetResult } from './types'
import { toCustomizationInfo } from '../transformer'
import { isSdfCreateOrUpdateGroupId, isSdfDeleteGroupId, isSuiteAppCreateRecordsGroupId, isSuiteAppDeleteRecordsGroupId, isSuiteAppUpdateRecordsGroupId, SUITEAPP_CREATING_FILES_GROUP_ID, SUITEAPP_DELETING_FILES_GROUP_ID, SUITEAPP_FILE_CABINET_GROUPS, SUITEAPP_UPDATING_CONFIG_GROUP_ID, SUITEAPP_UPDATING_FILES_GROUP_ID } from '../group_changes'
import { DeployResult, getElementValueOrAnnotations } from '../types'
import { CONFIG_FEATURES, APPLICATION_ID, SCRIPT_ID } from '../constants'
import { LazyElementsSourceIndexes } from '../elements_source_index/types'
import { toConfigDeployResult, toSetConfigTypes } from '../suiteapp_config_elements'
import { FeaturesDeployError, ObjectsDeployError, SettingsDeployError, ManifestValidationError, MissingManifestFeaturesError } from '../errors'
import { Graph, GraphNode } from './graph_utils'

const { isDefined } = values
const { awu } = collections.asynciterable
const { lookupValue } = values
const log = logger(module)
const { DefaultMap } = collections.map

const GROUP_TO_DEPLOY_TYPE: Record<string, DeployType> = {
  [SUITEAPP_CREATING_FILES_GROUP_ID]: 'add',
  [SUITEAPP_UPDATING_FILES_GROUP_ID]: 'update',
  [SUITEAPP_DELETING_FILES_GROUP_ID]: 'delete',
}

const getScriptIdFromElement = (changeData: ChangeDataType): string => {
  if (isField(changeData)) {
    return changeData.parent.annotations[SCRIPT_ID]
  }
  return getElementValueOrAnnotations(changeData)[SCRIPT_ID]
}

const getChangeType = (change: Change): 'addition' | 'modification' =>
  (isAdditionChange(change) ? 'addition' : 'modification')

const isSubsetOfArray = (subsetArray: unknown[], setArray: unknown[]):boolean =>
  subsetArray.length === _.intersection(subsetArray, setArray).length

type SDFObjectNode = {
  elemIdFullName: string
  scriptid: string
  changeType: 'addition' | 'modification'
  customizationInfos: CustomizationInfo[]
}

type DependencyInfo = {
  dependencyMap: Map<string, Set<string>>
  dependencyGraph: Graph<SDFObjectNode>
}

export default class NetsuiteClient {
  private sdfClient: SdfClient
  private suiteAppClient?: SuiteAppClient
  private suiteAppFileCabinet?: SuiteAppFileCabinetOperations
  public readonly url: URL

  constructor(sdfClient: SdfClient, suiteAppClient?: SuiteAppClient) {
    this.sdfClient = sdfClient
    this.suiteAppClient = suiteAppClient
    if (this.suiteAppClient === undefined) {
      log.debug('Salto SuiteApp not configured')
    } else {
      this.suiteAppFileCabinet = createSuiteAppFileCabinetOperations(this.suiteAppClient)
      log.debug('Salto SuiteApp configured')
    }

    this.url = new URL(`https://${toUrlAccountId(this.sdfClient.getCredentials().accountId)}.app.netsuite.com`)
  }

  @NetsuiteClient.logDecorator
  static async validateCredentials(credentials: Credentials): Promise<AccountId> {
    if (isSuiteAppCredentials(credentials)) {
      try {
        await SuiteAppClient.validateCredentials(credentials)
      } catch (e) {
        e.message = `Salto SuiteApp Authentication failed. ${e.message}`
        throw new CredentialError(e.message)
      }
    } else {
      log.debug('SuiteApp is not configured - skipping SuiteApp credentials validation')
    }

    try {
      return await SdfClient.validateCredentials(credentials)
    } catch (e) {
      e.message = `SDF Authentication failed. ${e.message}`
      throw new CredentialError(e)
    }
  }

  @NetsuiteClient.logDecorator
  async getConfigRecords(): Promise<ConfigRecord[]> {
    return this.suiteAppClient?.getConfigRecords() ?? []
  }

  @NetsuiteClient.logDecorator
  async deployConfigChanges(
    instancesChanges: Change<InstanceElement>[]
  ): Promise<DeployResult> {
    if (this.suiteAppClient === undefined) {
      return { errors: [new Error(`Salto SuiteApp is not configured and therefore changes group "${SUITEAPP_UPDATING_CONFIG_GROUP_ID}" cannot be deployed`)], appliedChanges: [] }
    }
    const modificationChanges = instancesChanges.filter(isModificationChange)
    return toConfigDeployResult(
      modificationChanges,
      await this.suiteAppClient.setConfigRecordsValues(
        toSetConfigTypes(modificationChanges)
      )
    )
  }

  @NetsuiteClient.logDecorator
  async getCustomObjects(typeNames: string[], query: NetsuiteQuery):
    Promise<GetCustomObjectsResult> {
    return this.sdfClient.getCustomObjects(typeNames, query)
  }

  @NetsuiteClient.logDecorator
  async importFileCabinetContent(query: NetsuiteQuery):
    Promise<ImportFileCabinetResult> {
    if (this.suiteAppFileCabinet !== undefined) {
      return this.suiteAppFileCabinet.importFileCabinet(query)
    }

    return this.sdfClient.importFileCabinetContent(query)
  }

  private static toFeaturesDeployPartialSuccessResult(
    error: FeaturesDeployError,
    changes: ReadonlyArray<Change<InstanceElement | ObjectType>>
  ): Change<InstanceElement | ObjectType>[] {
    // this case happens when all changes where deployed successfully,
    // except of some features in config_features
    const [[featuresChange], successfullyDeployedChanges] = _.partition(
      changes, change => getChangeData(change).elemID.typeName === CONFIG_FEATURES
    )

    // if some changed features are not in errors.ids we want to include the change
    if (isInstanceChange(featuresChange) && isModificationChange(featuresChange) && !_.isEqual(
      _(featuresChange.data.before.value.feature)
        .keyBy(feature => feature.id).omit(error.ids).value(),
      _(featuresChange.data.after.value.feature)
        .keyBy(feature => feature.id).omit(error.ids).value(),
    )) {
      successfullyDeployedChanges.push(featuresChange)
    }

    return successfullyDeployedChanges
  }

  private static getFailedSdfDeployChangesElemIDs(
    error: ObjectsDeployError,
    changes: ReadonlyArray<Change<InstanceElement | ObjectType>>,
    dependencyGraph: Graph<SDFObjectNode>,
  ): Set<string> {
    const changeData = changes.map(getChangeData)
    const failedElemIDs = changeData
      .filter(elem => (
        isInstanceElement(elem) && error.failedObjects.has(elem.value[SCRIPT_ID])
      ) || (
        error.failedObjects.has(elem.annotations[SCRIPT_ID])
      ))
      .map(elem => elem.elemID.getFullName())
    const failedElemIDsWithDependencies = new Set(
      NetsuiteClient.getDependenciesFromGraph(failedElemIDs, dependencyGraph)
    )

    // in case we cannot find the failed instances we return all as failed
    return failedElemIDsWithDependencies.size === 0
      ? new Set(changeData.map(elem => elem.elemID.getFullName()))
      : failedElemIDsWithDependencies
  }

  private static getFailedSettingsErrorChanges(
    changesToDeploy: Change[],
    dependencyGraph: Graph<SDFObjectNode>,
    failedConfigTypes: Set<string>
  ): Set<string> {
    const failedElemIdsByType = changesToDeploy
      .filter(change => failedConfigTypes.has(getChangeData(change).elemID.typeName))
      .map(change => getChangeData(change).elemID.getFullName())
    return new Set(NetsuiteClient.getDependenciesFromGraph(failedElemIdsByType, dependencyGraph))
  }

  private static async toCustomizationInfos(
    elements: (InstanceElement | ObjectType)[],
  ): Promise<CustomizationInfo[]> {
    return awu(elements)
      .map(getOrTransformCustomRecordTypeToInstance)
      .filter(isDefined)
      .map(toCustomizationInfo)
      .toArray()
  }

  private static async getSDFObjectNodes(
    changes: Change<InstanceElement | ObjectType>[],
  ): Promise<SDFObjectNode[]> {
    const elementsAndChangeTypes = changes
      .filter(isAdditionOrModificationChange)
      .map(change =>
        ({ element: getChangeData(change), changeType: getChangeType(change) }))
    return awu(elementsAndChangeTypes)
      .map(async ({ element, changeType }) => ({
        elemIdFullName: element.elemID.getFullName(),
        scriptid: getScriptIdFromElement(element),
        changeType,
        customizationInfos: await NetsuiteClient.toCustomizationInfos([element]),
      }))
      .toArray()
  }

  public static async createDependencyMapAndGraph(
    changes: Change<InstanceElement | ObjectType>[],
  ): Promise<DependencyInfo> {
    const dependencyMap = new DefaultMap<string, Set<string>>(() => new Set())
    const elemIdsAndCustInfos = await NetsuiteClient.getSDFObjectNodes(changes)
    const dependencyGraph = new Graph<SDFObjectNode>(
      'elemIdFullName', elemIdsAndCustInfos.map(elemIdsAndCustInfo => new GraphNode(elemIdsAndCustInfo))
    )
    elemIdsAndCustInfos.forEach(elemIdAndCustInfo => {
      const currSet = dependencyMap.get(elemIdAndCustInfo.elemIdFullName)
      const endNode = dependencyGraph.findNode(elemIdAndCustInfo)
      elemIdAndCustInfo.customizationInfos.forEach(custInfo =>
        lookupValue(custInfo.values, val => {
          if (!_.isString(val)) {
            return
          }
          const serviceIdInfoArray = captureServiceIdInfo(val)
          serviceIdInfoArray.forEach(serviceIdInfo => {
            currSet.add(serviceIdInfo.serviceId)
            const startNode = dependencyGraph.findNodeByField(SCRIPT_ID, serviceIdInfo.serviceId)
            if (startNode && endNode && startNode.value.changeType === 'addition') {
              startNode.addEdge(endNode)
            }
          })
        }))
    })
    return { dependencyMap, dependencyGraph }
  }

  private static getDependenciesFromGraph(
    elemIds: string[],
    dependencyGraph: Graph<SDFObjectNode>
  ):string[] {
    return elemIds.map(elementName => dependencyGraph.findNodeByKey(elementName))
      .filter(values.isDefined)
      .flatMap(node => dependencyGraph.getNodeDependencies(node))
      .map(node => node.value.elemIdFullName)
  }

  public static getFailedManifestErrorElemIds(
    error: ManifestValidationError,
    dependencyInfo: DependencyInfo,
    changes: ReadonlyArray<Change<InstanceElement | ObjectType>>
  ): Set<string> {
    const { dependencyMap, dependencyGraph } = dependencyInfo
    const changeData = changes.map(getChangeData)
    const baseElemIds = Array.from(dependencyMap.keys())
      .filter(topLevelChangedElement =>
        error.missingDependencyScriptIds.some(scriptid => dependencyMap.get(topLevelChangedElement)?.has(scriptid)))
    const elementsToRemoveElemIDs = new Set(
      NetsuiteClient.getDependenciesFromGraph(baseElemIds, dependencyGraph)
    )

    log.debug('remove elements which contain a scriptid that doesnt exist in target account: %o', elementsToRemoveElemIDs)
    return elementsToRemoveElemIDs.size === 0
      ? new Set(changeData.map(elem => elem.elemID.getFullName()))
      : elementsToRemoveElemIDs
  }

  private async sdfDeploy({
    changes,
    additionalDependencies,
    validateOnly = false,
  }: {
    changes: ReadonlyArray<Change>
    additionalDependencies: AdditionalDependencies
    validateOnly?: boolean
  }): Promise<DeployResult> {
    const changesToDeploy = changes.filter(
      change => isInstanceChange(change) || isObjectTypeChange(change)
    ) as Change<InstanceElement | ObjectType>[]
    const fieldChangesByType = _.groupBy(
      changes.filter(isFieldChange),
      change => getChangeData(change).parent.elemID.getFullName()
    )

    const someElementToDeploy = getChangeData(changes[0])
    const suiteAppId = getElementValueOrAnnotations(someElementToDeploy)[APPLICATION_ID]

    const errors: Error[] = []
    const { dependencyMap, dependencyGraph } = await NetsuiteClient.createDependencyMapAndGraph(changesToDeploy)
    while (changesToDeploy.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const customizationInfos = await NetsuiteClient.toCustomizationInfos(changesToDeploy.map(getChangeData))
      try {
        log.debug('deploying %d changes', changesToDeploy.length)
        // eslint-disable-next-line no-await-in-loop
        await log.time(
          () => this.sdfClient.deploy(
            customizationInfos,
            suiteAppId,
            { additionalDependencies, validateOnly }
          ),
          'sdfDeploy'
        )
        return {
          errors,
          appliedChanges: changesToDeploy.flatMap(change => [
            change,
            ...(fieldChangesByType[getChangeData(change).elemID.getFullName()] ?? []),
          ]),
        }
      } catch (error) {
        errors.push(error)
        if (error instanceof ManifestValidationError) {
          const elemIdNamesToRemove = NetsuiteClient.getFailedManifestErrorElemIds(
            error, { dependencyMap, dependencyGraph }, changesToDeploy
          )
          _.remove(
            changesToDeploy,
            change => elemIdNamesToRemove.has(getChangeData(change).elemID.getFullName())
          )
        } else if (error instanceof MissingManifestFeaturesError) {
          if (_.isEmpty(error.missingFeatures)
          || isSubsetOfArray(error.missingFeatures, additionalDependencies.include.features)) {
            return { errors, appliedChanges: [] }
          }
          additionalDependencies.include.features.push(...error.missingFeatures)
          // remove error because if the deploy succeeds there shouldn't be a change error
          errors.pop()
        } else if (error instanceof FeaturesDeployError) {
          const successfullyDeployedChanges = NetsuiteClient.toFeaturesDeployPartialSuccessResult(
            error, changesToDeploy
          )
          return { errors, appliedChanges: successfullyDeployedChanges }
        } else if (error instanceof ObjectsDeployError) {
          const failedElemIDs = NetsuiteClient.getFailedSdfDeployChangesElemIDs(
            error, changesToDeploy, dependencyGraph
          )
          log.debug('objects deploy error: sdf failed to deploy: %o', Array.from(failedElemIDs))
          _.remove(
            changesToDeploy,
            change => failedElemIDs.has(getChangeData(change).elemID.getFullName())
          )
        } else if (error instanceof SettingsDeployError) {
          const { failedConfigTypes } = error
          if (!changesToDeploy.some(change =>
            failedConfigTypes.has(getChangeData(change).elemID.typeName))) {
            log.debug('settings deploy error: no changes matched the failedConfigType list: %o', Array.from(failedConfigTypes))
            return { errors, appliedChanges: [] }
          }
          log.debug('settings deploy error: sdf failed to deploy: %o', Array.from(failedConfigTypes))
          const failedElemIDs = NetsuiteClient.getFailedSettingsErrorChanges(
            changesToDeploy, dependencyGraph, failedConfigTypes
          )
          _.remove(
            changesToDeploy,
            change => failedElemIDs.has(getChangeData(change).elemID.getFullName())
          )
        } else {
          // unknown error
          return { errors, appliedChanges: [] }
        }
      }
    }
    return { errors, appliedChanges: [] }
  }

  @NetsuiteClient.logDecorator
  public async validate(
    changes: Change[],
    groupID: string,
    additionalSdfDependencies: AdditionalDependencies,
  ): Promise<ReadonlyArray<Error>> {
    if (isSdfCreateOrUpdateGroupId(groupID)) {
      return (await this.sdfDeploy({
        changes,
        additionalDependencies: additionalSdfDependencies,
        validateOnly: true,
      })).errors
    }
    return []
  }

  @NetsuiteClient.logDecorator
  public async deploy(
    changes: Change[],
    groupID: string,
    additionalSdfDependencies: AdditionalDependencies,
    elementsSourceIndex: LazyElementsSourceIndexes,
  ): Promise<DeployResult> {
    if (isSdfCreateOrUpdateGroupId(groupID)) {
      return this.sdfDeploy({
        changes,
        additionalDependencies: additionalSdfDependencies,
      })
    }

    const instancesChanges = changes.filter(isInstanceChange)
    if (SUITEAPP_FILE_CABINET_GROUPS.includes(groupID)) {
      return this.suiteAppFileCabinet !== undefined
        ? this.suiteAppFileCabinet.deploy(
          instancesChanges,
          GROUP_TO_DEPLOY_TYPE[groupID],
          elementsSourceIndex
        )
        : { errors: [new Error(`Salto SuiteApp is not configured and therefore changes group "${groupID}" cannot be deployed`)], appliedChanges: [] }
    }

    if (groupID === SUITEAPP_UPDATING_CONFIG_GROUP_ID) {
      return this.deployConfigChanges(instancesChanges)
    }

    return this.deployRecords(changes, groupID)
  }

  private async deployRecords(changes: Change[], groupID: string): Promise<DeployResult> {
    const relevantInstances = changes.map(getChangeData).map(getOrTransformCustomRecordTypeToInstance).filter(isDefined)
    const relevantChanges = changes.filter(
      change => isDefined(getOrTransformCustomRecordTypeToInstance(getChangeData(change)))
    )

    const deployResults = await this.runDeployRecordsOperation(relevantInstances, groupID)
    const results = deployResults
      .map((result, index) => (typeof result === 'number' ? relevantChanges[index] : result))
      .filter(values.isDefined)

    const [errors, appliedChanges] = _.partition(
      results, res => res instanceof Error
    ) as [Error[], Change[]]

    const elemIdToInternalId = Object.fromEntries(deployResults
      .map((result, index) => (typeof result === 'number' ? [relevantInstances[index].elemID.getFullName(), result.toString()] : undefined))
      .filter(values.isDefined))

    return { errors, appliedChanges, elemIdToInternalId }
  }

  private async runDeployRecordsOperation(elements: InstanceElement[], groupID: string):
  Promise<(number | Error)[]> {
    if (this.suiteAppClient === undefined) {
      return [new Error(`Salto SuiteApp is not configured and therefore changes group "${groupID}" cannot be deployed`)]
    }

    if (isSuiteAppUpdateRecordsGroupId(groupID)) {
      return this.suiteAppClient.updateInstances(elements)
    }

    if (isSuiteAppCreateRecordsGroupId(groupID)) {
      return this.suiteAppClient.addInstances(elements)
    }

    if (isSuiteAppDeleteRecordsGroupId(groupID)) {
      return this.suiteAppClient.deleteInstances(elements)
    }

    if (isSdfDeleteGroupId(groupID)) {
      return this.suiteAppClient.deleteSdfInstances(elements)
    }

    throw new Error(`Cannot deploy group ID: ${groupID}`)
  }

  public async runSuiteQL(query: string):
    Promise<Record<string, unknown>[] | undefined> {
    return this.suiteAppClient?.runSuiteQL(query)
  }

  public async runSavedSearchQuery(query: SavedSearchQuery):
    Promise<Record<string, unknown>[] | undefined> {
    return this.suiteAppClient?.runSavedSearchQuery(query)
  }

  public async getSystemInformation(): Promise<SystemInformation | undefined> {
    return this.suiteAppClient?.getSystemInformation()
  }

  public isSuiteAppConfigured(): boolean {
    return this.suiteAppClient !== undefined
  }

  public getPathInternalId(path: string): number | undefined {
    const pathToId = this.suiteAppFileCabinet?.getPathToIdMap() ?? {}
    return pathToId[path]
  }

  private static logDecorator = decorators.wrapMethodWith(
    async (
      { call, name }: decorators.OriginalCall,
    ): Promise<unknown> => {
      const desc = `client.${name}`
      try {
        // eslint-disable-next-line @typescript-eslint/return-await
        return await log.time(call, desc)
      } catch (e) {
        log.error('failed to run Netsuite client command on: %o', e)
        throw e
      }
    }
  )

  public async getNetsuiteWsdl(): Promise<elementUtils.soap.WSDL | undefined> {
    return this.suiteAppClient?.getNetsuiteWsdl()
  }

  @NetsuiteClient.logDecorator
  public async getAllRecords(types: string[]): Promise<RecordValue[]> {
    if (this.suiteAppClient === undefined) {
      throw new Error('Cannot call getAllRecords when SuiteApp is not installed')
    }
    return this.suiteAppClient.getAllRecords(types)
  }

  @NetsuiteClient.logDecorator
  public async getCustomRecords(customRecordTypes: string[]): Promise<CustomRecordTypeRecords[]> {
    if (this.suiteAppClient === undefined) {
      throw new Error('Cannot call getCustomRecords when SuiteApp is not installed')
    }
    return this.suiteAppClient.getCustomRecords(customRecordTypes)
  }
}
