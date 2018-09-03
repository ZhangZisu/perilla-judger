export interface IBFileModel {
    _id: string;
    hash: string;
    owner: string;
    description: string;
    type: string;
    created?: Date;
}

export interface ISolutionModel {
    _id: string;
    problemID: string;
    files: string[];
    status: string;
    result?: any;
    meta?: any;
}

export interface IProblemModel {
    data: any;
    meta?: any;
}

export interface IJudgerConfig {
    server: string;
    username: string;
    password: string;
    user: string;
    cgroup: string;
    chroot: string;
}