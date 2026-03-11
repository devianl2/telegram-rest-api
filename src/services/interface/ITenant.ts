export interface Tenant {
	id: number;
	secret_id: string;
	secret_code: string;
	server_name: string;
	callback_url: string;
}
