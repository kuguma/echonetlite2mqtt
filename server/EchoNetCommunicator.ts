import EL, { facilitiesType,eldata,rinfo, DeviceDetailsType } from "echonet-lite";
import { Logger } from "./Logger";

export class EchoNetCommunicator
{
  public static initialize = async (
    objList: string[],
    ipVer?: number,
    Options?: {
      v4?: string;
      v6?: string;
      ignoreMe?: boolean;
      autoGetProperties?: boolean;
      autoGetDelay?: number;
      debugMode?: boolean;
    },
    commandTimeout?:number
  ): Promise<{ sock4: any; sock6: any } | any> =>
  {
    this.commandTimeout = commandTimeout ?? 1000;

    // maker code
    EL.Node_details["8a"][0]=0xff;
    EL.Node_details["8a"][1]=0xff;
    EL.Node_details["8a"][2]=0xfe;

    const result = EL.initialize(objList, this.echonetUserFunc, ipVer, Options);
    EL.Node_details["83"][1]=0xff;
    EL.Node_details["83"][2]=0xff;
    EL.Node_details["83"][3]=0xfe;
    return result;
  }

  public static release():void
  {
    EL.release();
  }

  public static updateidentifierFromMacAddress = (base:number[]):number[] =>
  {
    const result = JSON.parse(JSON.stringify(base));
    result[7]  = EL.Node_details["83"][7];
    result[8]  = EL.Node_details["83"][8];
    result[9]  = EL.Node_details["83"][9];
    result[10] = EL.Node_details["83"][10];
    result[11] = EL.Node_details["83"][11];
    result[12] = EL.Node_details["83"][12];

    return result;
  }

  static echonetUserFunc = (rinfo: rinfo, els: eldata, err: Error | null):void =>
  {
    if(err !== null)
    {
      Logger.error("[ECHONETLite][userfunc]", `caused error in echonet-lite.js packet parser. ${rinfo.address}: ${err.message}`);
      return;
    }
    // echonet-lite.js側で対処したので大丈夫なはずだが一応残しておく
    if(els == undefined || els === null || Object.keys(els).length === 0){
      if (rinfo == undefined) {
        Logger.error("[ECHONETLite][userfunc]", "rinfo and eldata are undefined");
      } else {
        Logger.error("[ECHONETLite][userfunc]", `els is undefined (from ${rinfo.address})`);
      }
      return;
    }
    if(els.ESV === ELSV.SET_RES)
    {
      this.setResponseHandlers.forEach(_=>_(rinfo,els));
    }
    if(els.ESV === ELSV.GET_RES)
    {
      this.getResponseHandlers.forEach(_=>_(rinfo,els));
    }

    // GETエラーだが、一部のプロパティは受信できているので、GetResponseとして扱う
    if(els.ESV === ELSV.GET_SNA)
    {
      this.getResponseHandlers.forEach(_=>_(rinfo,els));
    }
    if(els.ESV === ELSV.INF)
    {
      this.infoHandlers.forEach(_=>_(rinfo,els));
    }
    if(els.ESV === ELSV.SETC || els.ESV === ELSV.SETI)
    {
      this.setHandlers.forEach(_=>_(rinfo,els));
    }
    if(els.ESV === ELSV.GET)
    {
      this.getHandlers.forEach(_=>_(rinfo,els));
    }
    
    // TIDベースでコマンドレスポンスを取得
    const commandResponse = this.commandResponses.get(els.TID);
    if(commandResponse !== undefined)
    {
      // Logger.debug("[ECHONETLite][tid]", `Response matched: TID=${els.TID}, ${rinfo.address} ${els.SEOJ}->${els.DEOJ} ESV=${els.ESV}`);
      commandResponse.addResponse({rinfo, els});
    }
    else if(els.ESV === ELSV.SET_RES || els.ESV === ELSV.GET_RES || els.ESV === ELSV.GET_SNA)
    {
      // INFは応答ではないのでログ不要。応答系のみログ出力
      // Logger.debug("[ECHONETLite][tid]", `Response unmatched: TID=${els.TID}, ${rinfo.address} ${els.SEOJ}->${els.DEOJ} ESV=${els.ESV} (pending=${this.commandResponses.size})`);
    }
    
    this.reveivedHandlers.forEach(_=>_(rinfo,els));
  }

  static readonly getResponseHandlers:((rinfo: rinfo, els: eldata) => void)[] = [];
  public static addGetResponseHandler = (event:(rinfo: rinfo, els: eldata) => void):void =>
  {
    this.getResponseHandlers.push(event);
  }
  static readonly setResponseHandlers:((rinfo: rinfo, els: eldata) => void)[] = [];
  public static addSetResponseHandler = (event:(rinfo: rinfo, els: eldata) => void):void =>
  {
    this.setResponseHandlers.push(event);
  }

  static readonly infoHandlers:((rinfo: rinfo, els: eldata) => void)[] = [];
  public static addInfoHandler = (event:(rinfo: rinfo, els: eldata) => void):void =>
  {
    this.infoHandlers.push(event);
  }
  static readonly getHandlers:((rinfo: rinfo, els: eldata) => void)[] = [];
  public static addGetHandler = (event:(rinfo: rinfo, els: eldata) => void):void =>
  {
    this.getHandlers.push(event);
  }
  static readonly setHandlers:((rinfo: rinfo, els: eldata) => void)[] = [];
  public static addSetHandler = (event:(rinfo: rinfo, els: eldata) => void):void =>
  {
    this.setHandlers.push(event);
  }

  static readonly reveivedHandlers:((rinfo: rinfo, els: eldata) => void)[] = [];
  public static addReveivedHandler = (event:(rinfo: rinfo, els: eldata) => void):void =>
  {
    this.reveivedHandlers.push(event);
  }

  public static getFacilities = (): facilitiesType=>
  {
    return EL.facilities;
  }

  public static send = (
    ip: string,
    seoj: string | number[],
    deoj: string | number[],
    esv: string | number,
    epc: string | number,
    edt: string | number | number[]
  ): void =>
  {
    setTimeout(() => {
      EL.sendOPC1(ip, seoj, deoj, esv, epc, edt);
      EL.decreaseWaitings();
    }, EL.autoGetDelay * (EL.autoGetWaitings+1));
    EL.increaseWaitings();
  }
  public static sendNow = (
    ip: string,
    seoj: string | number[],
    deoj: string | number[],
    esv: string | number,
    epc: string | number,
    edt: string | number | number[]
  ): void =>
  {
    EL.sendOPC1(ip, seoj, deoj, esv, epc, edt);
  }

  public static setObserveFacilities = (interval: number, onChanged: () => void): void =>
  {
    EL.setObserveFacilities(interval, onChanged);
  }
  public static search = (): void =>
  {
    EL.search();
  }
  public static getPropertyMaps = (ip: string, eoj: string | number[]): void =>
  {
    EL.getPropertyMaps(ip, eoj);
  }
  public static getSendQueueLength = ():number => 
  {
    return EL.autoGetWaitings;
  }
  public static replySetDetail = async (rinfo: rinfo, els: eldata, dev_details:DeviceDetailsType):Promise<void> =>
  {
    return EL.replySetDetail(rinfo, els, dev_details);
  }
  public static replyGetDetail = async (rinfo: rinfo, els: eldata, dev_details:DeviceDetailsType):Promise<void> =>
  {
    return EL.replyGetDetail(rinfo, els, dev_details);
  }

  static commandTimeout=1000;
  static commandResponses: Map<string, CommandResponse> = new Map();
  
  public static execCommandPromise(
    ip: string,
    seoj: string,
    deoj: string,
    esv: string,
    epc: string,
    edt: string
  ): Promise<CommandResponse>
  {
    const command:Command = {
      ip,
      seoj,
      deoj,
      esv,
      epc,
      edt,
      tid: ""
    }
    const tid = EL.sendOPC1(ip, seoj, deoj, esv, epc, edt);
    command.tid = EL.bytesToString(tid);
    
    // TIDラップアラウンド対策: 同じTIDの古いCommandResponseがあれば削除
    const existingResponse = this.commandResponses.get(command.tid);
    if(existingResponse !== undefined)
    {
      existingResponse.cancelTimeout();
      this.commandResponses.delete(command.tid);
      Logger.warn("[ECHONETLite][comm]", `TID collision detected: ${command.tid}, old request removed`);
    }
    
    const commandResponse = new CommandResponse(command);
    // Logger.debug("[ECHONETLite][tid]", `Command sent: TID=${command.tid}, ${ip} ${seoj}->${deoj} ESV=${esv} EPC=${epc} (pending=${this.commandResponses.size + 1})`);

    return new Promise<CommandResponse>((resolve,reject)=>{
      const handle = setTimeout(()=>{
        this.commandResponses.delete(command.tid);
        // Logger.debug("[ECHONETLite][tid]", `Command timeout: TID=${command.tid}, ${ip} ${seoj}->${deoj} ESV=${esv} EPC=${epc}`);
        reject({message:"timeout", commandResponse});
      }, this.commandTimeout);
      
      commandResponse.timeoutHandle = handle;
      commandResponse.setCallback(()=>{
        this.commandResponses.delete(command.tid);
        commandResponse.cancelTimeout();
        // Logger.debug("[ECHONETLite][tid]", `Command completed: TID=${command.tid}, ${ip} ${seoj}->${deoj} ESV=${esv} EPC=${epc} (pending=${this.commandResponses.size})`);
        resolve(commandResponse);
      });
      
      this.commandResponses.set(command.tid, commandResponse);
    });
  }

  public static async getMultiPropertyPromise(
    ip: string,
    seoj: string,
    deoj: string,
    esv: string,
    epc: string[]
  ): Promise<CommandResponse>
  {
    const command:Command = {
      ip,
      seoj,
      deoj,
      esv,
      epc:"",
      edt:"",
      tid: ""
    }
    const edt:{[key:string]:string} = {};
    epc.forEach(_=>{
      edt[_]="";
    });
    const tid = await EL.sendDetails(ip, seoj, deoj, esv, edt);
    command.tid = EL.bytesToString(tid);
    
    // TIDラップアラウンド対策: 同じTIDの古いCommandResponseがあれば削除
    const existingResponse = this.commandResponses.get(command.tid);
    if(existingResponse !== undefined)
    {
      existingResponse.cancelTimeout();
      this.commandResponses.delete(command.tid);
      Logger.warn("[ECHONETLite][comm]", `TID collision detected: ${command.tid}, old request removed`);
    }
    
    const commandResponse = new CommandResponse(command);

    return await new Promise<CommandResponse>((resolve,reject)=>{
      const handle = setTimeout(()=>{
        this.commandResponses.delete(command.tid);
        reject({message:"timeout", commandResponse});
      }, this.commandTimeout);
      
      commandResponse.timeoutHandle = handle;
      commandResponse.setCallback(()=>{
        this.commandResponses.delete(command.tid);
        commandResponse.cancelTimeout();
        resolve(commandResponse);
      });
      
      this.commandResponses.set(command.tid, commandResponse);
    });
  }

  public static getForTimeoutPromise(
    ip: string,
    seoj: string,
    deoj: string,
    esv: string,
    epc: string,
    edt: string,
    timeout: number
  ): Promise<CommandResponse>
  {
    const command:Command = {
      ip,
      seoj,
      deoj,
      esv,
      epc,
      edt,
      tid: ""
    }
    const tid = EL.sendOPC1(ip, seoj, deoj, esv, epc, edt);
    command.tid = EL.bytesToString(tid);

    // TIDラップアラウンド対策: 同じTIDの古いCommandResponseがあれば削除
    const existingResponse = this.commandResponses.get(command.tid);
    if(existingResponse !== undefined)
    {
      existingResponse.cancelTimeout();
      this.commandResponses.delete(command.tid);
      Logger.warn("[ECHONETLite][comm]", `TID collision detected: ${command.tid}, old request removed`);
    }

    const commandResponse = new CommandResponse(command);

    return new Promise<CommandResponse>((resolve,reject)=>{
      const handle = setTimeout(()=>{
        this.commandResponses.delete(command.tid);
        resolve(commandResponse);
      }, timeout);

      commandResponse.timeoutHandle = handle;

      // 応答受信時のコールバックを設定（クリーンアップ用）
      commandResponse.setCallback(()=>{
        this.commandResponses.delete(command.tid);
        commandResponse.cancelTimeout();
        resolve(commandResponse);
      });

      this.commandResponses.set(command.tid, commandResponse);
    });
  }
}

export class ELSV
{
  public static readonly GET="62";
  public static readonly GET_RES="72";
  public static readonly INF="73";
  public static readonly SETC="61";
  public static readonly SETI="60";
  public static readonly SET_RES="71";
  public static readonly GET_SNA="52";
}


export interface Command
{
  ip: string,
  seoj: string,
  deoj: string,
  esv: string ,
  epc: string,
  edt: string;
  tid: string;
}

export class CommandResponse
{
  readonly command:Command;
  readonly createdAt:number; // TIDラップアラウンド対策用タイムスタンプ
  callback:()=>void = ()=>{};
  timeoutHandle?: NodeJS.Timeout; // タイムアウトハンドラの保持
  
  constructor(command:Command)
  {
    this.command = command;
    this.createdAt = Date.now();
  }
  responses:Response[] = [];

  public matchResponse = (filter:(response:Response)=>boolean):Response|undefined =>
  {
    const results = this.responses.filter(filter);
    if(results.length === 0)
    {
      return undefined;
    }
    return results[0];
  }

  public setCallback(callback:()=>void):void
  {
    this.callback = callback;
  }

  public cancelTimeout():void
  {
    if(this.timeoutHandle !== undefined)
    {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  public addResponse = (response:Response):void =>
  {
    if((this.command.ip === EL.EL_Multi || response.rinfo.address === this.command.ip ) && 
      response.els.SEOJ === this.command.deoj && response.els.DEOJ === this.command.seoj)
    {
      if(response.els.ESV === ELSV.SET_RES && this.command.esv === ELSV.SETC)
      {
        this.responses.push(response);
        this.callback();
      }
      if(response.els.ESV === ELSV.GET_RES && this.command.esv === ELSV.GET)
      {
        this.responses.push(response);
        this.callback();
      }
    }
  }
}

export interface Response
{
  rinfo: rinfo;
  els: eldata;
}


export interface RawDataSet
{
  existsDevice:(ip:string, eoj:string)=>boolean;
  existsData:(ip:string, eoj:string, epc:string)=>boolean;
  getIpList:()=>string[];
  getEojList:(ip:string)=>string[];
  getRawData:(ip:string, eoj:string, epc:string)=>string|undefined;
}
