
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

import {
  ChangeValidator, getChangeData, InstanceElement,
  isAdditionOrModificationChange, isInstanceElement,
} from '@salto-io/adapter-api'

import { resolveValues } from '@salto-io/adapter-utils'
import { collections } from '@salto-io/lowerdash'
import { isConditions } from '../filters/utils'
import { lookupFunc } from '../filters/field_references'


const { awu } = collections.asynciterable
export const AUTOMATION_TYPE_NAME = 'automation'

const fieldExist = (field: string): boolean =>
  ['status', 'type', 'group_id', 'assignee_id', 'requester_id'].includes(field)


const isNotValidData = (instance: InstanceElement): boolean => {
  const allConditions = instance.value.conditions?.all ?? []
  return !(isConditions(allConditions)
      && allConditions.some(condition => fieldExist(condition.field)))
}

export const automationAllConditionsValidator: ChangeValidator = async changes => {
  const relevantInstances = await awu(changes)
    .filter(isAdditionOrModificationChange)
    .map(getChangeData)
    .filter(isInstanceElement)
    .filter(instance => instance.elemID.typeName === AUTOMATION_TYPE_NAME)
    .map(data => resolveValues(data, lookupFunc))
    .filter(isNotValidData)
    .toArray()

  return relevantInstances
    .flatMap(instance => [{
      elemID: instance.elemID,
      severity: 'Error',
      message: 'Automation must test for at least one of the following ticket properties in the ALL '
          + 'conditions section: Status, Type, Group, Assignee, Requester',
      detailedMessage: `Automation ${instance.elemID.getFullName()} must test for at least one of 
      the following ticket properties in the ALL conditions section: Status, Type, Group, Assignee, 
      Requester`,
    }])
}
