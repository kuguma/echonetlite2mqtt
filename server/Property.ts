import { ElDeviceDescription, ElPropertyDescription } from "./MraTypes";

export interface Manufacturer{
  code: string;
  descriptions:{
    ja:string;
    en:string;
  }
}

export interface Protocol{
  type:string;
  version:string;
}

export interface PropertyValue
{
  name:string;
  deviceProperty:Property;
  value:any;
  updated:string; // YYYY-NN-DD HH:mm:ssZ (UTC)
}

export interface Device{
  id:string;
  name:string;
  ip:string;
  deviceType:string;
  schema:ElDeviceDescription,
  eoj:string;
  internalId:string;
  descriptions:{
    ja:string;
    en:string;
  };
  properties:Property[];
  protocol: Protocol;
  manufacturer:Manufacturer;
  propertiesValue: {[key:string]:PropertyValue};
}

export class Device{
  public static ToProperiesObject(propertyValues:{[key:string]:PropertyValue}):{[key:string]:any}
  {
    const result:{[key:string]:any}= {};
    for(const name in propertyValues)
    {
      result[name] = propertyValues[name].value;
    }

    return result;
  }
}


export interface Property {
  name:string;
  epc:string;
  descriptions:{
      ja:string;
      en:string;
  },
  readable: boolean;
  writable:boolean;
  observable: boolean;
  schema:ElPropertyDescription;
}

export interface DeviceId {
  id:string;
  ip:string;
  eoj:string;
  internalId:string;
}

export interface DeviceFriendlyName
{
  id?:string;
  eoj?:string;
  ip?:string;
  name:string;
}

export interface ValidationResult
{
  valid:boolean;
  message:string;
}

export class DeviceFriendlyName
{
  static validate(deviceFriendlyName:DeviceFriendlyName):ValidationResult
  {
    let message = "";
    if(deviceFriendlyName.id !== undefined && deviceFriendlyName.id.match(/[^0-9a-fA-F\*]/) !== null)
    {
      message = "id must be hexadecimal or '*' : " + deviceFriendlyName.id;
    }
    if(deviceFriendlyName.eoj !== undefined && deviceFriendlyName.eoj.match(/[^0-9a-fA-F\*]/) !== null)
    {
      message = "eoj must be hexadecimal or '*' : " + deviceFriendlyName.eoj;
    }
    if(deviceFriendlyName.ip !== undefined && deviceFriendlyName.ip.match(/[^0-9\.\*]/) !== null)
    {
      message = "ip must decimal number , '.' or '*' : " + deviceFriendlyName.ip;
    }
    
    if(message === "")
    {
      return {valid:true, message};
    }
    else
    {
      return {valid:false, message};
    }
  }
  static isMatch(deviceFriendlyName:DeviceFriendlyName, id:string, eoj:string, ip:string):boolean
  {
    // deviceFriendlyNameのid,eoj,ipのうち、undefinedでないものがdeviceIdと一致しているか確認する
    // これらのid,eoj,ipの中に含まれる * はワイルドカードとして扱うので、正規表現でマッチングする
    if(deviceFriendlyName.id !== undefined)
    {
      if(id.match(deviceFriendlyName.id.replace(/\*/gi, ".*")) === null)
      {
        return false;
      }
    }
    if(deviceFriendlyName.eoj !== undefined)
    {
      if(eoj.match(deviceFriendlyName.eoj.replace(/\*/gi, ".*")) === null)
      {
        return false;
      }
    }
    if(deviceFriendlyName.ip !== undefined)
    {
      // ipは正規表現のエスケープをしてから比較する
      if(ip.match(deviceFriendlyName.ip.replace(/\./gi, "\\.").replace(/\*/g, ".*")) === null)
      {
        return false;
      }
    }

    return true;
  }
}

export interface FriendlyNameOption
{
  friendlyNames: DeviceFriendlyName[];
}

export class FriendlyNameOption
{
  public static empty: Readonly<FriendlyNameOption> = {
    friendlyNames: []
  };
  public static validate(friendlyNameOption:FriendlyNameOption):ValidationResult
  {
    if(friendlyNameOption.friendlyNames===undefined)
    {
      return {valid:false, message:"friendlyNames is undefined"};
    }
    if(Array.isArray(friendlyNameOption.friendlyNames)===false)
    {
      return {valid:false, message:"friendlyNames is not array"};
    }

    const faildValidationResults = friendlyNameOption.friendlyNames
      .map(_=>DeviceFriendlyName.validate(_)).filter(_=>_.valid===false);
    if(faildValidationResults.length>0)
    {
      return {valid:false, 
        message:faildValidationResults.map(_=>_.message).join("\n")};
    }

    return {valid:true, message:""};
  }
}