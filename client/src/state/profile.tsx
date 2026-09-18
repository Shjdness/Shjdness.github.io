import { createContext } from "react";

export type Profile = {
  id: number;
  avatar: string;
  permission: boolean;
  canWrite: boolean;
  role: 'owner' | 'guest' | 'reader';
  name: string
}

export const ProfileContext = createContext<Profile | undefined>(undefined);
