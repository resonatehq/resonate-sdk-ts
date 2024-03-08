// class ID {
//     private id: string;

//     constructor(
//         id: string,
//         private prefix : string[],
//         private seperator : string = "/",
//     ){
//         const p = prefix.join(seperator) + seperator;

//         if (id.startsWith(p)) {
//             this.id = id.replace(p, "");
//         } else {
//             this.id = id;
//         }
//     }

//     public relative(): string {
//         return this.id;
//     }

//     public absolute(): string {
//         return this.prefix.join(this.seperator) + this.seperator + this.id;
//     }

// }
