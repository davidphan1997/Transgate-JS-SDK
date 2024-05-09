import Web3, { Address } from 'web3';
import { server, extensionId } from './constants';
import { EventDataType, Result, Task, TaskConfig, VerifyResult } from './types';
import { ErrorCode, TransgateError } from './error';

export default class TransgateConnect {
  readonly appid: string;
  readonly baseServer: string;
  transgateAvailable?: boolean;
  constructor(appid: string) {
    this.appid = appid;
    this.baseServer = server;
  }

  async launch(schemaId: string, address?: Address) {
    const transgateAvailable = await this.isTransgateAvailable();
    if (!transgateAvailable) {
      throw new TransgateError(ErrorCode.TRANSGATE_NOT_INSTALLED, 'Please install transgate before generate proof.');
    }

    const config = await this.requestConfig();
    if (config.schemas.findIndex((schema) => schema.schema_id === schemaId) === -1) {
      throw new TransgateError(ErrorCode.ILLEGAL_SCHEMA_ID, 'Illegal schema id, please check your schema info');
    }

    const schemaUrl = `${this.baseServer}/schema/${schemaId}`;

    const schemaInfo = await this.requestSchemaInfo(schemaUrl);
    const taskInfo = await this.requestTaskInfo(config.task_rpc, config.token, schemaId);
    const {
      task,
      alloc_address: allocatorAddress,
      alloc_signature: signature,
      node_address: nodeAddress,
      node_host: nodeHost,
      node_pk: nodePK,
    } = taskInfo;    
    const extensionParams = {
      task,
      allocatorAddress,
      nodeAddress,
      nodeHost,
      nodePK,
      signature,
      ...schemaInfo,
      appid: this.appid,
    };

    this.launchTransgate(extensionParams, address);

    return new Promise((resolve, reject) => {
      const eventListener = (event: any) => {
        if (event.data.id !== extensionParams.id) {
          return;
        }
        if (event.data.type === EventDataType.GENERATE_ZKP_SUCCESS) {
          window?.removeEventListener('message', eventListener);
          const message: VerifyResult = event.data;
          const { taskId, nullifierHash, publicFields = [], signature } = message;
          const publicFieldsList = publicFields.map((item: any) => item.str);
          const publicData =
            publicFieldsList.length > 0 ? publicFieldsList.reduce((a: string, b: string) => a + b) : '';

          if (
            this.verifyMessageSignature(taskId, schemaId, nullifierHash, publicData, signature, nodeAddress, address)
          ) {
            resolve(this.buildResult(message, taskInfo, publicData, allocatorAddress, address));
          } else {
            reject(
              new TransgateError(
                ErrorCode.ILLEGAL_NODE,
                'The verification node is not the same as the node assigned to the task.',
              ),
            );
          }
        } else if (event.data.type === EventDataType.NOT_MATCH_REQUIREMENTS) {
          window?.removeEventListener('message', eventListener);
          reject(new TransgateError(ErrorCode.NOT_MATCH_REQUIREMENTS, 'The user does not meet the requirements.'));
        } else if (event.data.type === EventDataType.ILLEGAL_WINDOW_CLOSING) {
          window?.removeEventListener('message', eventListener);
          reject(
            new TransgateError(
              ErrorCode.VERIFICATION_CANCELED,
              'The user closes the window before finishing validation.',
            ),
          );
        } else if (event.data.type === EventDataType.UNEXPECTED_VERIFY_ERROR) {
          window?.removeEventListener('message', eventListener);
          reject(
            new TransgateError(
              ErrorCode.UNEXPECTED_VERIFY_ERROR,
              'An unexpected error was encountered, please try again.',
            ),
          );
        }
      };
      window?.addEventListener('message', eventListener);
    });
  }

  private launchTransgate(taskInfo: any, address?: Address) {
    window?.postMessage(
      {
        type: 'AUTH_ZKPASS',
        mintAccount: address,
        ...taskInfo,
      },
      '*',
    );
  }

  /**
   * request task info
   * @param {*} schemaId string schema id
   * @returns
   */
  private async requestTaskInfo(taskUrl: string, token: string, schemaId: string): Promise<Task> {
    const response = await fetch(`https://${taskUrl}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token,
        schema_id: schemaId,
        app_id: this.appid,
      }),
    });
    if (response.ok) {
      const result = await response.json();
      return result.info;
    }

    throw new TransgateError(ErrorCode.TASK_RPC_ERROR, 'Request task info error');
  }

  private async requestConfig(): Promise<TaskConfig> {
    const response = await fetch(`${this.baseServer}/sdk/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: this.appid,
      }),
    });
    if (response.ok) {
      const result = await response.json();
      return result.info;
    }

    throw new TransgateError(ErrorCode.ILLEGAL_APPID, 'Please check your appid');
  }
  /**
   * request schema detail info
   * @param schemaUrl
   */
  private async requestSchemaInfo(schemaUrl: string) {
    const response = await fetch(schemaUrl);
    if (response.ok) {
      return await response.json();
    }
    throw new TransgateError(ErrorCode.ILLEGAL_SCHEMA_ID, 'Illegal schema url, please contact develop team!');
  }

  async isTransgateAvailable() {
    try {
      const url = `chrome-extension://${extensionId}/images/icon-16.png`;
      const { statusText } = await fetch(url);
      if (statusText === 'OK') {
        this.transgateAvailable = true;
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }
  /**
   * check signature is matched with task info
   * @param taskId
   * @param schemaId
   * @param nullifier
   * @param publicData
   * @param signature
   * @param originAddress
   * @returns
   */
  private verifyMessageSignature(
    taskId: string,
    schemaId: string,
    nullifier: string,
    publicData: string,
    signature: string,
    originAddress: string,
    recipient?: string,
  ) {
    const web3 = new Web3();

    const publicFieldsHex = !!publicData ? Web3.utils.stringToHex(publicData) : Web3.utils.utf8ToHex('1');
    const publicFieldsHash = Web3.utils.soliditySha3(publicFieldsHex);

    const types = ['bytes32', 'bytes32', 'bytes32', 'bytes32'];
    const values = [Web3.utils.stringToHex(taskId), Web3.utils.stringToHex(schemaId), nullifier, publicFieldsHash];

    if (recipient) {
      types.push('address');
      values.push(recipient);
    }

    const encodeParams = web3.eth.abi.encodeParameters(types, values);

    const paramsHash = Web3.utils.soliditySha3(encodeParams) as string;

    const nodeAddress = web3.eth.accounts.recover(paramsHash, signature);
    return nodeAddress === originAddress;
  }
  private buildResult(
    data: VerifyResult,
    taskInfo: Task,
    publicData: string,
    allocatorAddress: string,
    recipient?: string,
  ): Result {
    const { publicFields, taskId, nullifierHash, signature } = data;
    const { node_address: nodeAddress, alloc_signature: allocSignature } = taskInfo;
    const publicFieldsHash = Web3.utils.soliditySha3(
      !!publicData ? Web3.utils.stringToHex(publicData) : Web3.utils.utf8ToHex('1'),
    ) as string;

    return {
      taskId,
      publicFields,
      allocatorAddress,
      publicFieldsHash,
      allocatorSignature: allocSignature,
      uHash: nullifierHash,
      validatorAddress: nodeAddress,
      validatorSignature: signature,
      recipient,
    };
  }
}