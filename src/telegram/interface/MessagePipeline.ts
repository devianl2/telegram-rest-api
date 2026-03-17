import { Api } from "telegram";

export interface ParsedMedia {
	fileUniqueId: string;
	fileType: string;
	rawInputJson: string;
}

export type FlushCallback = (messages: Api.Message[]) => Promise<void>;
